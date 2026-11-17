// Import Library
import type * as SentryModule from "@sentry/node";
import { tryGetContext } from "hono/context-storage";
// Import Config
import { getSecurityAlertConfig } from "../config/security.config";
// Import Services
import { formatBangkokTime, sendLineAlert } from "./security-alert.service";
// Import Types
import type { AppEnv } from "../types/app.types";
import type { ForwardResult } from "../types/log.types";
// Import Utils
import { logger, redact } from "../utils/logger";

/* -------------------------------------- Types -------------------------------------- */

// Type ที่มาของ error เช่น http, background:forward-line-events, process:uncaughtException
export interface ErrorReportContext {
  source: string;
  extra?: Record<string, unknown>;
}

/* -------------------------------------- Config -------------------------------------- */

// Config header ที่ห้ามส่งไป Sentry
const SENSITIVE_HEADER_PATTERN = /^(authorization|proxy-authorization|cookie|set-cookie|x-line-signature|x-api-key|x-proxy-secret)$/i;

// Config จำนวนครั้งที่ส่งต่อ webhook ไป project เดิมล้มเหลวติดกันก่อนแจ้งเตือน
const FORWARD_FAILURE_ALERT_THRESHOLD = 5;

// Config Sentry SDK (null = ไม่ได้ตั้ง SENTRY_DSN โหลดเฉพาะตอนใช้จริง)
let sentry: typeof SentryModule | null = null;

// Config ตัวนับการส่งต่อ webhook ที่ล้มเหลวติดกันต่อ project (ใน memory ของ process)
const forwardFailures = new Map<string, { count: number; alerted: boolean }>();

/* -------------------------------------- Helpers -------------------------------------- */

// Function อ่านข้อมูลของ request ปัจจุบัน (ไม่อยู่ใน request = ค่าว่าง)
function readRequestMeta(): { requestId: string | null; method: string | null; path: string | null; accountId: number | null } {
  const c = tryGetContext<AppEnv>();

  if (!c) {
    return { requestId: null, method: null, path: null, accountId: null };
  }

  return { requestId: c.get("requestId") ?? null, method: c.req.method, path: c.req.path, accountId: c.get("auth")?.account_id ?? null };
}

// Function แปลงค่าที่ throw มาเป็น Error เสมอ (Sentry และข้อความแจ้งเตือนต้องมี name / message / stack)
function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(typeof error === "string" ? error : JSON.stringify(redact(error)) ?? String(error));
}

// Function ลบข้อมูลลับออกจาก event ก่อนส่งไป Sentry (header สำคัญ, คุกกี้ และ body ที่อาจมีรหัสผ่าน)
function scrubEvent<T extends SentryModule.ErrorEvent>(event: T): T {
  if (event.request) {
    delete event.request.cookies;
    delete event.request.data;

    if (event.request.headers) {
      event.request.headers = Object.fromEntries(Object.entries(event.request.headers).filter(([name]) => !SENSITIVE_HEADER_PATTERN.test(name)));
    }
  }

  return event;
}

// Function สร้างข้อความแจ้งเตือน error เข้า LINE
function buildErrorText(error: Error, context: ErrorReportContext, request: ReturnType<typeof readRequestMeta>): string {
  const firstFrame = error.stack?.split("\n").find((line) => line.trim().startsWith("at "))?.trim();
  const lines = [
    "[center-hook] System error",
    `source: ${context.source}${request.method ? ` (${request.method} ${request.path})` : ""}`,
    `error: ${error.name}: ${error.message.slice(0, 300)}`,
    firstFrame ? `where: ${firstFrame.slice(0, 200)}` : null,
    `time: ${formatBangkokTime(new Date())}`,
    request.requestId ? `request_id: ${request.requestId}` : null,
    sentry ? "ดูรายละเอียดเต็มใน Sentry" : null,
  ];

  return lines.filter(Boolean).join("\n");
}

/* -------------------------------------- Functions -------------------------------------- */

// Function เปิดส่ง error ไป Sentry (เรียกครั้งเดียวตอน start server ไม่ตั้ง SENTRY_DSN = ไม่ทำอะไร)
export function initErrorReporting(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  const environment = process.env.NODE_ENV || "development";

  if (!dsn || sentry) {
    return;
  }

  sentry = require("@sentry/node") as typeof SentryModule;
  sentry.init({
    dsn,
    environment,
    // ติด tag app:backend ไว้กรองใน Sentry (frontend ไม่ได้ส่ง error มา Sentry แล้ว)
    initialScope: { tags: { app: "backend", runtime: "server" } },
    // ไม่ส่ง IP / คุกกี้ / body (อาจมีรหัสผ่าน) / ค่าตัวแปรใน stack / ข้อมูลใน query DB (แนบแค่ account id เอง)
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { deny: ["authorization", "proxy-authorization", "cookie", "set-cookie", "x-line-signature", "x-api-key", "x-proxy-secret"] },
      httpBodies: [],
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: scrubEvent,
  });
  logger.info("Sentry error reporting enabled.", { environment });
}

// Function รายงาน error ของระบบ: ส่ง Sentry (ถ้าตั้ง SENTRY_DSN) และแจ้งเตือนเข้า LINE (error เดิมไม่ส่งซ้ำในช่วง cooldown)
// ไม่ throw เสมอ คืน Promise ของการส่ง LINE ไว้ให้รอได้ตอน process กำลังจะล้ม
export function reportError(error: unknown, context: ErrorReportContext): Promise<void> {
  const err = toError(error);
  const request = readRequestMeta();

  try {
    sentry?.withScope((scope) => {
      scope.setTag("source", context.source);

      if (request.requestId) {
        scope.setTag("request_id", request.requestId);
      }

      if (request.method) {
        scope.setContext("request_meta", { method: request.method, path: request.path });
      }

      if (request.accountId) {
        scope.setUser({ id: String(request.accountId) });
      }

      if (context.extra) {
        scope.setExtras(redact(context.extra) as Record<string, unknown>);
      }

      sentry?.captureException(err);
    });
  } catch (sentryError) {
    logger.warn("Failed to report error to Sentry.", { error: sentryError });
  }

  // ส่ง LINE ไปที่เดียวกับแจ้งเตือนความปลอดภัย (SECURITY_ALERT_LINE_TO)
  const { lineTo, cooldownMs } = getSecurityAlertConfig();

  return sendLineAlert({
    lineTo,
    cooldownMs,
    cooldownKey: `error|${context.source}|${err.name}|${err.message.slice(0, 120)}`,
    text: buildErrorText(err, context, request),
  }).then(() => undefined);
}

// Function นับผลการส่งต่อ webhook ต่อ project: ล้มเหลวติดกันถึงเกณฑ์แจ้งเตือนครั้งเดียว และแจ้งอีกครั้งเมื่อกลับมาส่งได้
export function trackForwardResult(project: string, targetUrl: string | null, result: Pick<ForwardResult, "status" | "http_status" | "error_message">): void {
  if (result.status === "SKIPPED") {
    return;
  }

  const { lineTo, cooldownMs } = getSecurityAlertConfig();
  const entry = forwardFailures.get(project) ?? { count: 0, alerted: false };

  if (result.status === "SUCCESS") {
    forwardFailures.delete(project);

    if (entry.alerted) {
      logger.info("Forwarding recovered.", { project });
      void sendLineAlert({
        lineTo,
        cooldownMs,
        cooldownKey: `forward-recovered|${project}`,
        text: ["[center-hook] Forward recovered", `project: ${project}`, `target: ${targetUrl ?? "-"}`, `time: ${formatBangkokTime(new Date())}`].join("\n"),
      });
    }

    return;
  }

  entry.count += 1;
  forwardFailures.set(project, entry);

  if (entry.alerted || entry.count < FORWARD_FAILURE_ALERT_THRESHOLD) {
    return;
  }

  entry.alerted = true;
  logger.error("Forwarding keeps failing.", { alertCode: "FORWARD_FAILING", project, targetUrl, consecutiveFailures: entry.count, error: result.error_message });

  try {
    sentry?.captureMessage(`Forward to ${project} failed ${entry.count} times in a row`, {
      level: "error",
      tags: { source: "forward", project },
      extra: { target_url: targetUrl, http_status: result.http_status, error_message: result.error_message },
    });
  } catch (sentryError) {
    logger.warn("Failed to report error to Sentry.", { error: sentryError });
  }

  void sendLineAlert({
    lineTo,
    cooldownMs,
    cooldownKey: `forward-failed|${project}`,
    text: [
      "[center-hook] Forward failing",
      `project: ${project}`,
      `target: ${targetUrl ?? "-"}`,
      `failed: ${entry.count} times in a row`,
      `last error: ${result.http_status ? `HTTP ${result.http_status}` : result.error_message ?? "-"}`,
      `time: ${formatBangkokTime(new Date())}`,
    ].join("\n"),
  });
}

// Function รอส่ง error ที่ค้างไป Sentry ให้หมดก่อนปิด process
export async function flushErrorReporting(timeoutMs: number): Promise<void> {
  await sentry?.flush(timeoutMs).catch(() => false);
}

// Function ล้างตัวนับการส่งต่อที่ล้มเหลว (ใช้ใน test)
export function resetErrorReportState(): void {
  forwardFailures.clear();
}
