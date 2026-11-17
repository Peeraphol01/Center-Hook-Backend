// Import Library
import dotenv from "dotenv";
import { serve } from "@hono/node-server";

dotenv.config({ quiet: true });

// ตรวจ secret ของระบบ login ก่อนเปิด server (ไม่ตั้งหรืออ่อนเกินให้ล้มตั้งแต่ start ไม่ใช่ไปพังตอนมีคน login)
const { readSecret } = require("./src/config/auth.config");
for (const name of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "REFRESH_TOKEN_HASH_SECRET"]) readSecret(name);

// ตรวจค่า env ด้านความปลอดภัย (TRUST_PROXY_HOPS, IP_ALLOWLIST_ADMIN, IP_ALLOWLIST_LINE_PUSH ฯลฯ) ตั้งผิดให้ล้มตั้งแต่ start
require("./src/config/security.config").validateSecurityConfig();

// เปิดส่ง error ไป Sentry ก่อนโหลด app (ไม่ตั้ง SENTRY_DSN = ไม่ส่ง)
const { initErrorReporting, reportError, flushErrorReporting } = require("./src/services/error-report.service");
initErrorReporting();

const { default: app } = require("./src/app");
const { FORWARD_LOG_CLEANUP_INTERVAL_MS } = require("./src/config/app.config");
const { closePrisma } = require("./src/config/database");
const { waitForBackgroundTasks } = require("./src/utils/background-tasks");
const { deleteExpiredForwardLogs } = require("./src/services/log.service");
const { deleteExpiredAuditLogs } = require("./src/services/audit.service");
const { startGeoIp } = require("./src/services/geoip.service");
const { logger } = require("./src/utils/logger");

/* -------------------------------------- Config -------------------------------------- */

// Config host, port และเวลารองานค้างก่อนปิด process
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST || "0.0.0.0";
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000);

/* -------------------------------------- Functions -------------------------------------- */

// Function ลบ forward log และ audit log ที่หมดอายุ (error แค่เขียน log)
function cleanupForwardLogs(): void {
  deleteExpiredForwardLogs()
    .then((deleted: number) => deleted > 0 && logger.info("Deleted expired forward logs.", { deleted }))
    .catch((error: unknown) => {
      logger.error("Failed to delete expired forward logs.", { error });
      void reportError(error, { source: "cleanup:forward-logs" });
    });
  deleteExpiredAuditLogs()
    .then((deleted: number) => deleted > 0 && logger.info("Deleted expired audit logs.", { deleted }))
    .catch((error: unknown) => {
      logger.error("Failed to delete expired audit logs.", { error });
      void reportError(error, { source: "cleanup:audit-logs" });
    });
}

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled promise rejection.", { error: reason });
  void reportError(reason, { source: "process:unhandledRejection" });
});

// error ที่ไม่มีใครจับ = state ของ process เชื่อไม่ได้แล้ว: รายงาน (รอไม่เกิน 3 วินาที) แล้วปิดให้ Docker / PM2 start ใหม่
process.on("uncaughtException", (error: Error) => {
  logger.error("Uncaught exception.", { error });
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000));
  void Promise.race([Promise.all([reportError(error, { source: "process:uncaughtException" }), flushErrorReporting(2500)]), timeout]).finally(() => process.exit(1));
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  logger.info("Server started.", { host: HOST, port: PORT });
  cleanupForwardLogs();
});

// โหลด/อัปเดตฐานข้อมูล GeoLite2 สำหรับระบุตำแหน่งจาก IP ใน audit log (ไม่ตั้ง MAXMIND_* = ไม่ระบุตำแหน่ง)
const geoIpTimer = startGeoIp();

const cleanupTimer = setInterval(cleanupForwardLogs, FORWARD_LOG_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

// Function ปิด server แบบ graceful (หยุดรับ request แล้วรอส่งต่อ event ที่ค้างให้จบ)
async function shutdown(signal: string): Promise<void> {
  logger.info("Shutting down.", { signal });
  clearInterval(cleanupTimer);
  clearInterval(geoIpTimer);
  server.close();

  const finished = await waitForBackgroundTasks(SHUTDOWN_TIMEOUT_MS);

  if (!finished) {
    logger.warn("Shutdown timeout reached with pending forward tasks.");
  }

  await closePrisma();
  await flushErrorReporting(2000);
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
