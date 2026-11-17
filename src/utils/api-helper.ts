// Import Library
import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError, ZodType } from "zod";
// Import Config
import { getProxySharedSecret, getTrustProxyHops } from "../config/security.config";
// Import Types
import type { AppContext, AppEnv } from "../types/app.types";
// Import Utils
import { normalizeIp, pickForwardedIp } from "./ip";

/* -------------------------------------- Errors -------------------------------------- */

// Class error กลางของระบบ (error.middleware แปลงเป็น JSON { status_code, code, message, request_id })
export class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);

    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

/* -------------------------------------- Request / Response -------------------------------------- */

// Function สร้าง router ของ app (ยอมรับ / ท้าย path เหมือนกันทุก route)
export function createRouter(): Hono<AppEnv> {
  return new Hono<AppEnv>({ strict: false });
}

// Function ตอบ JSON พร้อม status code
export function sendJson(c: AppContext, body: unknown, status = 200): Response {
  return c.json(body as object, status as ContentfulStatusCode);
}

// Function เทียบรหัสลับแบบใช้เวลาเท่ากันเสมอ (กันเดารหัสทีละตัวจากเวลาที่ตอบ)
function isSameSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) {
    return false;
  }

  const hash = (value: string) => createHash("sha256").update(value).digest();

  return timingSafeEqual(hash(provided), hash(expected));
}

// Function หา IP ของ client
// 1) request มาจาก frontend (x-proxy-secret ตรงกับ PROXY_SHARED_SECRET) = เชื่อ x-client-ip ที่ frontend อ่านจากผู้ใช้จริง
// 2) นอกนั้น (LINE, project, ยิงตรง) เชื่อ X-Forwarded-For ตามจำนวน proxy ใน TRUST_PROXY_HOPS (นับจากขวา)
// TRUST_PROXY_HOPS=0 = ไม่เชื่อ header เลย (ใช้เมื่อ client ยิงตรงถึง app ได้ ไม่งั้นปลอม IP ได้) ค่าใน header ผิดรูปใช้ IP ของ socket
export function getClientIp(c: AppContext): string | null {
  const proxySecret = getProxySharedSecret();

  if (proxySecret && isSameSecret(c.req.header("x-proxy-secret"), proxySecret)) {
    const clientIp = normalizeIp(c.req.header("x-client-ip"));

    if (clientIp) {
      return clientIp;
    }
  }

  const forwardedFor = pickForwardedIp(c.req.header("x-forwarded-for"), getTrustProxyHops());

  return forwardedFor || normalizeIp(c.env?.incoming?.socket.remoteAddress);
}

// Function อ่าน query string (key ซ้ำใช้ค่าสุดท้าย)
export function getQuery(c: AppContext): Record<string, string> {
  return c.req.query();
}

/* -------------------------------------- Validation -------------------------------------- */

// Type option สำหรับแปลง validation error เป็น ApiError
interface ParseOptions {
  statusCode?: number;
  code?: string;
  message?: string;
}

// Function จัดรูปแบบ zod issues เป็นรายการ field/message
function formatZodIssues(error: ZodError): { field: string | null; message: string }[] {
  return error.issues.map((issue) => ({
    field: issue.path.length > 0 ? issue.path.join(".") : null,
    message: issue.message,
  }));
}

// Function อ่าน input ด้วย Zod schema และโยน ApiError มาตรฐานเมื่อไม่ผ่าน (ค่าเริ่มต้น 400 VALIDATION_ERROR)
export function parseWithSchema<T>(schema: ZodType<T>, input: unknown, options: ParseOptions = {}): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    throw new ApiError(
      options.statusCode ?? 400,
      options.code ?? "VALIDATION_ERROR",
      options.message ?? "Invalid request data.",
      { validation_errors: formatZodIssues(result.error) }
    );
  }

  return result.data;
}
