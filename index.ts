// Import Library
import dotenv from "dotenv";
import { serve } from "@hono/node-server";

dotenv.config({ quiet: true });

// ตรวจ secret ของระบบ login ก่อนเปิด server (ไม่ตั้งหรืออ่อนเกินให้ล้มตั้งแต่ start ไม่ใช่ไปพังตอนมีคน login)
const { readSecret } = require("./src/config/auth.config");
for (const name of ["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "REFRESH_TOKEN_HASH_SECRET"]) readSecret(name);

const { default: app } = require("./src/app");
const { FORWARD_LOG_CLEANUP_INTERVAL_MS } = require("./src/config/app.config");
const { closePrisma } = require("./src/config/database");
const { waitForBackgroundTasks } = require("./src/utils/background-tasks");
const { deleteExpiredForwardLogs } = require("./src/services/log.service");
const { logger } = require("./src/utils/logger");

/* -------------------------------------- Config -------------------------------------- */

// Config host, port และเวลารองานค้างก่อนปิด process
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST || "0.0.0.0";
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS ?? 15_000);

/* -------------------------------------- Functions -------------------------------------- */

// Function ลบ forward log ที่หมดอายุ (error แค่เขียน log)
function cleanupForwardLogs(): void {
  deleteExpiredForwardLogs()
    .then((deleted: number) => deleted > 0 && logger.info("Deleted expired forward logs.", { deleted }))
    .catch((error: unknown) => logger.error("Failed to delete expired forward logs.", { error }));
}

process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled promise rejection.", { error: reason });
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  logger.info("Server started.", { host: HOST, port: PORT });
  cleanupForwardLogs();
});

const cleanupTimer = setInterval(cleanupForwardLogs, FORWARD_LOG_CLEANUP_INTERVAL_MS);
cleanupTimer.unref();

// Function ปิด server แบบ graceful (หยุดรับ request แล้วรอส่งต่อ event ที่ค้างให้จบ)
async function shutdown(signal: string): Promise<void> {
  logger.info("Shutting down.", { signal });
  clearInterval(cleanupTimer);
  server.close();

  const finished = await waitForBackgroundTasks(SHUTDOWN_TIMEOUT_MS);

  if (!finished) {
    logger.warn("Shutdown timeout reached with pending forward tasks.");
  }

  await closePrisma();
  process.exit(0);
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
