// Import Library
import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler, Next } from "hono";
// Import Config
import { readOptionalEnv } from "../config/env";
import type { Permission } from "../config/permission.config";
// Import Repositories
import * as accountRepository from "../repositories/account.repository";
import * as sessionRepository from "../repositories/session.repository";
// Import Services
import { recordAudit } from "../services/audit.service";
import { inactiveSessionError } from "../services/auth.service";
// Import Types
import type { AppContext, AppEnv } from "../types/app.types";
import type { AccessTokenPayload } from "../types/auth.types";
// Import Utils
import { ApiError, getClientIp } from "../utils/api-helper";
import { isAccessTokenNearingExpiry, verifyAccessToken } from "../utils/jwt";

/* -------------------------------------- Helpers -------------------------------------- */

// Function เทียบ secret สองค่าแบบ timing-safe (hash ก่อนให้ยาวเท่ากันเสมอ)
function isSameSecret(given: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();

  return timingSafeEqual(digest(given), digest(expected));
}

// Function ดึง Bearer token จาก Authorization header (ไม่มีหรือผิดรูปคืน null)
function readBearerToken(c: AppContext): string | null {
  return c.req.header("authorization")?.match(/^Bearer\s+(\S+)\s*$/i)?.[1] ?? null;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ยืนยันตัว project ที่เรียก /api/line/push ด้วย Authorization: Bearer <LINE_CHANNEL_ACCESS_TOKEN>
// ใช้ token ตัวเดียวกับ center-hook แทน key แยก เพราะผู้ที่มี token ส่งหา LINE ตรงได้อยู่แล้ว
export async function lineTokenAuth(c: AppContext, next: Next): Promise<void> {
  const token = readOptionalEnv("LINE_CHANNEL_ACCESS_TOKEN");

  if (!token) {
    throw new ApiError(503, "LINE_PUSH_NOT_CONFIGURED", "LINE_CHANNEL_ACCESS_TOKEN is not configured.");
  }

  const given = readBearerToken(c);

  if (!given || !isSameSecret(given, token)) {
    recordAudit(
      { action: "line.push.unauthorized", result: "denied", metadata: { reason: given ? "invalid_token" : "missing_token" } },
      { throttleKey: getClientIp(c) ?? "unknown" }
    );
    throw new ApiError(401, "INVALID_ACCESS_TOKEN", "Authorization: Bearer <LINE channel access token> is required.");
  }

  await next();
}

// Function ตรวจ access token ของผู้ดูแล + เช็ค session และบัญชีใน DB ทุก request (logout/ถูกปิด/ถูกลบ มีผลทันทีไม่ต้องรอ token หมดอายุ)
export async function requireAuth(c: AppContext, next: Next): Promise<void> {
  const token = readBearerToken(c);

  if (!token) {
    throw new ApiError(401, "INVALID_TOKEN", "Authorization: Bearer <access token> is required.");
  }

  const payload = verifyAccessToken(token);
  const session = await sessionRepository.findActiveById(payload.session_id);

  if (!session || session.account_id !== payload.account_id) {
    throw await inactiveSessionError(payload.session_id, new ApiError(401, "INVALID_TOKEN", "Session is no longer active."));
  }

  const account = await accountRepository.findById(payload.account_id);

  if (!account || account.status !== "active") {
    throw new ApiError(401, "INVALID_TOKEN", "Account is inactive.");
  }

  c.set("auth", payload);

  // แค่เตือนให้ client ไป /api/auth/refresh เอง ไม่เซ็น token ใหม่ให้ที่นี่
  if (isAccessTokenNearingExpiry(payload.exp)) {
    c.header("X-Should-Refresh", "true");
  }

  await next();
}

// Function ดึง payload ของผู้ดูแลที่ผ่าน requireAuth แล้ว (ไม่มี = ลืมวาง requireAuth ตอบ 401 ไว้ก่อน)
export function getAuth(c: AppContext): AccessTokenPayload {
  const auth = c.get("auth");

  if (!auth) {
    throw new ApiError(401, "INVALID_TOKEN", "Authorization: Bearer <access token> is required.");
  }

  return auth;
}

// Function สร้าง middleware ตรวจว่าผู้ดูแลมีครบทุกสิทธิ์ที่ route ต้องการ (วางหลัง requireAuth)
export function requirePermission(...required: Permission[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const granted = c.get("auth")?.permissions ?? [];
    const missing = required.filter((permission) => !granted.includes(permission));

    if (missing.length > 0) {
      recordAudit({ action: "access.denied", result: "denied", metadata: { required_permissions: missing } });
      throw new ApiError(403, "FORBIDDEN", "Permission denied.", { required_permissions: missing });
    }

    await next();
  };
}
