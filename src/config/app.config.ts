// Import Config
import { readPositiveIntegerEnv } from "./env";

/* -------------------------------------- Config -------------------------------------- */

// Config การส่งต่อ event ไปปลายทาง (replyToken อายุสั้น จึง retry น้อยครั้งและไม่รอนาน)
export const FORWARD_CONFIG = {
  timeoutMs: readPositiveIntegerEnv("FORWARD_TIMEOUT_MS", 10_000),
  maxAttempts: readPositiveIntegerEnv("FORWARD_MAX_ATTEMPTS", 3),
  retryDelayMs: readPositiveIntegerEnv("FORWARD_RETRY_DELAY_MS", 1_000),
  // ตัดข้อความที่เก็บลง log ไม่ให้ใหญ่เกิน
  maxContentLength: 1_000,
  maxResponseBodyLength: 2_000,
} as const;

// Config อายุ forward log ก่อนลบอัตโนมัติ (วัน)
export const FORWARD_LOG_RETENTION_DAYS = readPositiveIntegerEnv("FORWARD_LOG_RETENTION_DAYS", 90);

// Config อายุ cache รายการ webhook (แก้ผ่าน /api/webhooks แล้วล้าง cache ทันที ค่านี้กันกรณีแก้ DB ตรงๆ หรือรันหลาย instance)
export const WEBHOOK_CACHE_MS = 30 * 1000;

// Config อายุ cache ชื่อ/รูปโปรไฟล์ LINE ก่อนถาม LINE ใหม่ (ชั่วโมง)
export const LINE_PROFILE_CACHE_MS = readPositiveIntegerEnv("LINE_PROFILE_CACHE_HOURS", 24) * 60 * 60 * 1000;

// Config รอบการลบ forward log ที่หมดอายุ (6 ชั่วโมง)
export const FORWARD_LOG_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Config LINE Messaging API ที่ center-hook เรียกแทน project (ขาไป)
export const LINE_API_CONFIG = {
  pushUrl: "https://api.line.me/v2/bot/message/push",
  replyUrl: "https://api.line.me/v2/bot/message/reply",
  // ชื่อ/รูปโปรไฟล์ที่แสดงในหน้าแชทของ log
  profileUrl: "https://api.line.me/v2/bot/profile",
  groupUrl: "https://api.line.me/v2/bot/group",
  // ต้องสั้นกว่า timeout ฝั่ง project ที่เรียก /api/line/push
  timeoutMs: readPositiveIntegerEnv("LINE_API_TIMEOUT_MS", 10_000),
} as const;
