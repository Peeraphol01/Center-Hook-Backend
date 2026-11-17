// Import Library
import type { Next } from "hono";
// Import Config
import { getAdminAllowlist, getLinePushAllowlist } from "../config/security.config";
// Import Services
import { recordAudit } from "../services/audit.service";
// Import Types
import type { AppContext } from "../types/app.types";
// Import Utils
import { ApiError, getClientIp } from "../utils/api-helper";
import type { IpMatcher } from "../utils/ip";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config path ของหน้า admin ที่ใช้ IP_ALLOWLIST_ADMIN (ไม่รวม /api/line/webhook เพราะ LINE ไม่มีชุด IP ตายตัว ใช้ x-line-signature แทน)
const ADMIN_PATH_PATTERN = /^\/(api\/(auth|admins|dashboard|forward-logs|webhooks|audit-logs)|api-docs)(\/|$)/;

// Config path ของขาไปที่ใช้ IP_ALLOWLIST_LINE_PUSH
const LINE_PUSH_PATH_PATTERN = /^\/api\/line\/push\/?$/;

// Config ช่วงเวลาที่บันทึก audit ของ IP ที่ถูกบล็อกซ้ำได้ (กันโดนยิงถี่จนตาราง audit บวม)
const BLOCKED_AUDIT_THROTTLE_MS = 5 * 60 * 1000;

/* -------------------------------------- Functions -------------------------------------- */

// Function เลือก allowlist ตาม path (null = path นี้ไม่จำกัด IP หรือยังไม่ตั้ง env)
function findAllowlist(path: string): { scope: "admin" | "line_push"; matcher: IpMatcher } | null {
  if (ADMIN_PATH_PATTERN.test(path)) {
    const matcher = getAdminAllowlist();
    return matcher ? { scope: "admin", matcher } : null;
  }

  if (LINE_PUSH_PATH_PATTERN.test(path)) {
    const matcher = getLinePushAllowlist();
    return matcher ? { scope: "line_push", matcher } : null;
  }

  return null;
}

// Function อนุญาตเฉพาะ IP ในวงที่ตั้งไว้ (IP_ALLOWLIST_ADMIN / IP_ALLOWLIST_LINE_PUSH) ไม่อยู่ในวงตอบ 403 IP_NOT_ALLOWED
export async function ipAllowlistMiddleware(c: AppContext, next: Next): Promise<void> {
  const allowlist = findAllowlist(c.req.path);

  if (allowlist) {
    const ip = getClientIp(c);

    if (!allowlist.matcher.matches(ip)) {
      logger.warn("Request blocked by IP allowlist.", { requestId: c.get("requestId"), ip, path: c.req.path, scope: allowlist.scope });
      recordAudit(
        { action: "security.ip_blocked", result: "denied", metadata: { scope: allowlist.scope } },
        { throttleKey: `${allowlist.scope}|${ip ?? "unknown"}`, throttleMs: BLOCKED_AUDIT_THROTTLE_MS }
      );
      throw new ApiError(403, "IP_NOT_ALLOWED", "Access from this IP address is not allowed.");
    }
  }

  await next();
}
