// Import Library
import pino from "pino";

/* -------------------------------------- Types -------------------------------------- */

// Type ข้อมูลเสริมที่แนบไปกับ log
type LogContext = Record<string, unknown>;

/* -------------------------------------- Config -------------------------------------- */

// Config ข้อความแทนค่าที่ถูกปิดบัง และ pattern ของ key ที่ต้องปิดบัง
const REDACTED = "[REDACTED]";
const SECRET_KEY_PATTERN = /(authorization|password|secret|token|database_url|signature)/i;

// Config pino logger ที่เขียน JSON ออก stdout
const pinoLogger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: null,
  messageKey: "message",
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  formatters: { level: (label) => ({ level: label }) },
});

/* -------------------------------------- Functions -------------------------------------- */

// Function ปิดบังค่า secret ใน log context แบบ recursive (Error เก็บ message/stack)
function redact(value: unknown, key?: string): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) {
    return REDACTED;
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }

  if (Array.isArray(value)) {
    return value.map((item) => redact(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
  }

  return value;
}

// Config logger กลางของระบบ (ปิดบัง secret ก่อนเขียนเสมอ)
export const logger = {
  info: (message: string, context: LogContext = {}) => pinoLogger.info(redact(context) as object, message),
  warn: (message: string, context: LogContext = {}) => pinoLogger.warn(redact(context) as object, message),
  error: (message: string, context: LogContext = {}) => pinoLogger.error(redact(context) as object, message),
};
