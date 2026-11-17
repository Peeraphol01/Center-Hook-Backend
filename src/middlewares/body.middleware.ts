// Import Library
import type { Next } from "hono";
import { bodyLimit } from "hono/body-limit";
// Import Types
import type { AppContext } from "../types/app.types";
// Import Utils
import { ApiError } from "../utils/api-helper";

/* -------------------------------------- Config -------------------------------------- */

// Config ขนาด body สูงสุด (1MB เผื่อ LINE ส่งหลาย event ใน request เดียว)
const BODY_LIMIT_BYTES = 1024 * 1024;

// Config path ที่เก็บ raw body ไว้ตรวจ signature และไม่ parse ล่วงหน้า
const RAW_BODY_PATHS = new Set(["/api/line/webhook"]);

/* -------------------------------------- Functions -------------------------------------- */

// Function จำกัดขนาด body ทุก request (ตัดทันทีที่อ่านเกินเพดาน ไม่อ่านทั้งก้อนเข้า memory ก่อน)
export const bodyLimitMiddleware = bodyLimit({
  maxSize: BODY_LIMIT_BYTES,
  onError: () => {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
  },
});

// Function อ่าน JSON body ลง context (path webhook เก็บเป็น raw body) ต้องวางหลัง bodyLimitMiddleware
export async function jsonBodyMiddleware(c: AppContext, next: Next): Promise<void> {
  const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();

  if (contentType !== "application/json") {
    await next();
    return;
  }

  const text = await c.req.text();

  if (RAW_BODY_PATHS.has(c.req.path)) {
    c.set("rawBody", text);
  } else if (text) {
    try {
      c.set("body", JSON.parse(text));
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", "Invalid JSON body.");
    }
  }

  await next();
}
