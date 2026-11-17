// Import Library
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError, ZodType } from "zod";
// Import Types
import type { AppContext, AppEnv } from "../types/app.types";

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

// Function หา IP ของ client (เชื่อ proxy 1 ชั้น: ใช้ค่าขวาสุดของ X-Forwarded-For ไม่มีจึงใช้ socket)
export function getClientIp(c: AppContext): string | null {
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();

  return forwardedFor || c.env?.incoming?.socket.remoteAddress || null;
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
