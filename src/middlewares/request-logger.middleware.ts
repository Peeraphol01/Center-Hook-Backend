// Import Library
import type { Next } from "hono";
// Import Types
import type { AppContext } from "../types/app.types";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config path ที่ไม่เขียน request log (health check ถี่เกิน)
const SKIP_LOG_PATHS = new Set(["/"]);

/* -------------------------------------- Functions -------------------------------------- */

// Function เขียน log หลังตอบ request (request id มาจาก requestId() ของ hono ที่วางไว้ก่อนหน้า)
export async function requestLoggerMiddleware(c: AppContext, next: Next): Promise<void> {
  const startedAt = Date.now();

  await next();

  if (!SKIP_LOG_PATHS.has(c.req.path)) {
    logger.info("Request completed.", {
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Date.now() - startedAt,
      errorCode: c.get("errorCode"),
    });
  }
}
