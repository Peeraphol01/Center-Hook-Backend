// Import Config
import { getAccessTokenExpiresInSeconds, getLoginLockoutConfig, getRefreshTokenExpiresInSeconds } from "../config/auth.config";
import { withTransaction, type DbClient } from "../config/database";
// Import Repositories
import * as accountRepository from "../repositories/account.repository";
import * as sessionRepository from "../repositories/session.repository";
// Import Services
import { recordAudit } from "./audit.service";
// Import Types
import type { AccessTokenPayload, AccountDto, AccountRecord, LoginResponse, MeResponse, RequestMeta, SessionRecord, TokenResponse } from "../types/auth.types";
// Import Utils
import { ApiError, parseWithSchema } from "../utils/api-helper";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt";
import { logger } from "../utils/logger";
import { hashPassword, verifyPassword } from "../utils/password";
import { hashRefreshToken, refreshTokenHashesMatch } from "../utils/refresh-token-hash";
// Import Validations
import { changeOwnPasswordBodySchema, loginBodySchema, refreshBodySchema } from "../validations/auth.schema";

/* -------------------------------------- Config -------------------------------------- */

// Config hash หลอกให้ verify ทำงานเสมอแม้ไม่พบ username (เวลาตอบเท่ากัน เดา username จากเวลาไม่ได้)
let dummyHashPromise: Promise<string> | null = null;

/* -------------------------------------- Helpers -------------------------------------- */

// Function คืน hash หลอก (สร้างครั้งแรกตอนใช้ ไม่เสียเวลาตอนโหลด module)
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword("dummy-password-for-constant-time-login");
  return dummyHashPromise;
}

// Function ตัด password_hash / ตัวนับรหัสผิดออกก่อนส่งออก API (locked_until ที่หมดเวลาแล้วส่งเป็น null)
export function toAccountDto(account: AccountRecord): AccountDto {
  const { password_hash: _passwordHash, failed_login_count: _failedLoginCount, ...dto } = account;
  return { ...dto, locked_until: getLockRemainingMs(account) > 0 ? account.locked_until : null };
}

// Function คืนเวลาที่เหลือของการล็อก (ms) ไม่ล็อกหรือหมดเวลาแล้วคืน 0
export function getLockRemainingMs(account: Pick<AccountRecord, "locked_until">): number {
  return account.locked_until ? Math.max(new Date(account.locked_until).getTime() - Date.now(), 0) : 0;
}

// Function สร้าง error 423 ของบัญชีที่ถูกล็อก (บอกเวลาที่ปลดล็อก)
function accountLockedError(lockedUntil: string): ApiError {
  const retryAfterSeconds = Math.ceil(Math.max(new Date(lockedUntil).getTime() - Date.now(), 0) / 1000);

  return new ApiError(423, "ACCOUNT_LOCKED", "Too many failed login attempts. Account is temporarily locked.", {
    locked_until: lockedUntil,
    retry_after_seconds: retryAfterSeconds,
  });
}

// Function นับรหัสผิด ครบ LOGIN_MAX_FAILED_ATTEMPTS ล็อกบัญชี LOGIN_LOCK_MINUTES แล้วตอบ 423 ตั้งแต่ครั้งที่ครบ
async function recordFailedLogin(account: AccountRecord): Promise<void> {
  const { maxFailedAttempts, lockMs } = getLoginLockoutConfig();
  const failedCount = await accountRepository.incrementFailedLogin(account.id);

  if (failedCount < maxFailedAttempts) {
    return;
  }

  const lockedUntil = new Date(Date.now() + lockMs);

  await accountRepository.lockAccount(account.id, lockedUntil);
  logger.warn("Account locked after too many failed logins.", { accountId: account.id, username: account.username, lockedUntil });
  recordAudit({
    action: "auth.account.locked",
    result: "denied",
    actor_account_id: account.id,
    actor_username: account.username,
    session_id: null,
    target_type: "account",
    target_id: account.id,
    metadata: { failed_attempts: failedCount, locked_until: lockedUntil.toISOString() },
  });
  throw accountLockedError(lockedUntil.toISOString());
}

// Function สร้าง error 401 ของ login (ตอบเหมือนกันทุกกรณี ไม่บอกว่า username มีจริงหรือบัญชีถูกปิด)
function invalidCredentials(): ApiError {
  return new ApiError(401, "INVALID_CREDENTIALS", "Invalid username or password.");
}

// Function เซ็น access/refresh token ของ session แล้วเก็บ hash ของ refresh token (permissions อ่านจาก DB ล่าสุด)
async function issueTokens(account: AccountRecord, sessionId: number, currentHash: string, db?: DbClient): Promise<TokenResponse & { permissions: MeResponse["permissions"] }> {
  const permissions = await accountRepository.listPermissions(account.id, db);
  const accessToken = signAccessToken({ account_id: account.id, session_id: sessionId, role: account.role, permissions });
  const refreshToken = signRefreshToken({ account_id: account.id, session_id: sessionId });
  const rotated = await sessionRepository.rotateRefreshTokenHash(sessionId, hashRefreshToken(refreshToken), currentHash, db);

  if (!rotated) {
    // อีก request ใช้ refresh token เดียวกันไปก่อนแล้ว (หรือ session ถูก revoke ระหว่างทาง)
    throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: getAccessTokenExpiresInSeconds(),
    permissions,
  };
}

// Function ตรวจว่า login นี้มาจาก IP ที่บัญชีไม่เคยใช้ (login ครั้งแรกของบัญชีไม่นับ / ไม่รู้ IP ไม่นับ)
async function isNewLoginIp(accountId: number, ipAddress: string | null, db: DbClient): Promise<boolean> {
  if (!ipAddress) {
    return false;
  }

  return (await sessionRepository.hasAnySession(accountId, db)) && !(await sessionRepository.hasSessionFromIp(accountId, ipAddress, db));
}

// Function ตรวจว่า session เป็นของเครื่องเดียวกับที่กำลัง login (ไม่รู้รหัสเครื่องฝั่งใดฝั่งหนึ่ง = ถือว่าคนละเครื่อง)
function isSameDevice(session: SessionRecord, deviceId: string | null | undefined): boolean {
  return Boolean(deviceId) && session.device_id === deviceId;
}

// Function สร้าง error 409 เมื่อบัญชีใช้งานอยู่บนเครื่องอื่น (แนบข้อมูลเครื่องเดิมให้หน้าเว็บถามผู้ใช้ก่อนเตะออก)
function activeOnOtherDeviceError(session: SessionRecord): ApiError {
  return new ApiError(409, "ACTIVE_ON_OTHER_DEVICE", "This account is signed in on another device.", {
    other_device: { user_agent: session.user_agent, ip_address: session.ip_address, last_active_at: session.last_active_at },
  });
}

// Function เลือก error 401 ของ session ที่ใช้ไม่ได้แล้ว (ถูกเครื่องอื่นเตะออก = SESSION_REPLACED ให้หน้าเว็บแจ้งผู้ใช้)
export async function inactiveSessionError(sessionId: number, fallback: ApiError): Promise<ApiError> {
  const session = await sessionRepository.findById(sessionId);

  if (session?.revoke_reason === "replaced") {
    return new ApiError(401, "SESSION_REPLACED", "This account was signed in on another device.");
  }

  return fallback;
}

// Function ดึงบัญชีที่ยัง active ไม่ผ่าน throw ตาม error ที่ส่งมา
async function requireActiveAccount(accountId: number, error: ApiError): Promise<AccountRecord> {
  const account = await accountRepository.findById(accountId);

  if (!account || account.status !== "active") {
    throw error;
  }

  return account;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function login ด้วย username/password — 1 บัญชีใช้ได้ 1 เครื่อง
// - เครื่องเดิม (device_id ตรง) = แทน session เดิมเงียบๆ
// - ใช้อยู่บนเครื่องอื่น = ตอบ 409 ACTIVE_ON_OTHER_DEVICE จนกว่าจะส่ง replace_session: true มา แล้วเตะเครื่องเดิมออกทันที
export async function login(body: unknown, meta: RequestMeta): Promise<LoginResponse> {
  const { username, password, device_id: deviceId, replace_session: replaceSession } = parseWithSchema(loginBodySchema, body);
  const account = await accountRepository.findByUsername(username);

  // ล็อกอยู่ = ไม่ตรวจรหัสเลย (รหัสถูกก็เข้าไม่ได้จนหมดเวลา)
  if (account && getLockRemainingMs(account) > 0) {
    recordAudit({ action: "auth.login.blocked", result: "denied", actor_account_id: account.id, actor_username: account.username, session_id: null, metadata: { reason: "account_locked" } });
    throw accountLockedError(account.locked_until as string);
  }

  const passwordValid = await verifyPassword(password, account?.password_hash ?? (await getDummyHash()));

  if (!account || !passwordValid || account.status !== "active") {
    const reason = !account ? "unknown_username" : !passwordValid ? "invalid_password" : "account_inactive";

    logger.warn("Login failed.", { username, reason });
    // เก็บ username ที่พิมพ์มาแม้ไม่มีบัญชีจริง (ใช้ดูการไล่เดา username)
    recordAudit({ action: "auth.login.failed", result: "failure", actor_account_id: account?.id ?? null, actor_username: username, session_id: null, metadata: { reason } });

    if (account && !passwordValid) {
      await recordFailedLogin(account);
    }

    throw invalidCredentials();
  }

  const result = await withTransaction(async (tx) => {
    // lock บัญชีก่อนจัดการ session กัน login พร้อมกันสองที่แล้วเหลือสอง session
    await accountRepository.lockById(account.id, tx);
    const locked = await accountRepository.findById(account.id, tx);

    if (!locked || locked.status !== "active") {
      throw invalidCredentials();
    }

    // รหัสถูก = เริ่มนับรหัสผิดใหม่ (ทั้งกรณี login สำเร็จและติดเครื่องอื่น)
    if (locked.failed_login_count > 0 || locked.locked_until) {
      await accountRepository.clearLoginFailures(locked.id, tx);
    }

    const activeSessions = await sessionRepository.listActiveByAccountId(locked.id, tx);
    const otherDevice = activeSessions.find((session) => !isSameDevice(session, deviceId)) ?? null;

    if (otherDevice && !replaceSession) {
      return { kind: "conflict" as const, conflict: otherDevice };
    }

    await sessionRepository.revokeAllByAccountId(locked.id, otherDevice ? "replaced" : "relogin", tx);

    // เช็คก่อนสร้าง session ใหม่: เคย login มาก่อนแต่ไม่เคยจาก IP นี้ = IP ใหม่
    const newIp = await isNewLoginIp(locked.id, meta.ip_address, tx);
    const expiresAt = new Date(Date.now() + getRefreshTokenExpiresInSeconds() * 1000);
    const session = await sessionRepository.createSession(locked.id, expiresAt, { ...meta, device_id: deviceId ?? null }, tx);
    const { permissions, ...tokens } = await issueTokens(locked, session.id, session.refresh_token_hash, tx);

    return { kind: "ok" as const, response: { ...tokens, profile: { ...toAccountDto(locked), permissions } }, sessionId: session.id, newIp, replaced: otherDevice };
  });

  if (result.kind === "conflict") {
    logger.info("Login needs confirmation: account is active on another device.", { accountId: account.id, username: account.username });
    recordAudit({
      action: "auth.login.device_conflict",
      result: "denied",
      actor_account_id: account.id,
      actor_username: account.username,
      session_id: null,
      metadata: { other_session_id: result.conflict.id, other_ip_address: result.conflict.ip_address },
    });
    throw activeOnOtherDeviceError(result.conflict);
  }

  logger.info("Login succeeded.", { accountId: account.id, username: account.username });
  const actor = { actor_account_id: account.id, actor_username: account.username, session_id: result.sessionId };
  recordAudit({ action: "auth.login.success", result: "success", ...actor });

  if (result.replaced) {
    logger.warn("Session on another device was replaced.", { accountId: account.id, replacedSessionId: result.replaced.id });
    recordAudit({
      action: "auth.session.replaced",
      result: "success",
      ...actor,
      target_type: "session",
      target_id: result.replaced.id,
      metadata: {
        replaced_ip_address: result.replaced.ip_address,
        replaced_user_agent: result.replaced.user_agent?.slice(0, 200) ?? null,
        replaced_last_active_at: result.replaced.last_active_at,
      },
    });
  }

  if (result.newIp) {
    recordAudit({ action: "auth.login.new_ip", result: "success", ...actor });
  }

  return result.response;
}

// Function ออก token ชุดใหม่ด้วย refresh token (refresh token เดิมใช้ซ้ำไม่ได้ / สิทธิ์ใน access token อ่านจาก DB ใหม่)
// token ที่เซ็นถูกต้องแต่ hash ไม่ตรงกับ session = refresh token รุ่นเก่าที่หมุนไปแล้วถูกนำกลับมาใช้ (น่าจะถูกขโมย) revoke session ทันที
export async function refresh(body: unknown): Promise<TokenResponse> {
  const { refresh_token: refreshToken } = parseWithSchema(refreshBodySchema, body);
  let payload: ReturnType<typeof verifyRefreshToken>;

  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (error) {
    recordAudit({ action: "auth.refresh.failed", result: "failure", actor_account_id: null, session_id: null, metadata: { reason: "invalid_token" } });
    throw error;
  }

  const actor = { actor_account_id: payload.account_id, session_id: payload.session_id };
  const session = await sessionRepository.findActiveById(payload.session_id);
  const invalid = new ApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");

  if (!session || session.account_id !== payload.account_id) {
    recordAudit({ action: "auth.refresh.failed", result: "failure", ...actor, metadata: { reason: "session_inactive" } });
    throw await inactiveSessionError(payload.session_id, invalid);
  }

  if (!refreshTokenHashesMatch(hashRefreshToken(refreshToken), session.refresh_token_hash)) {
    await sessionRepository.revoke(session.id, "reuse_detected");
    logger.warn("Refresh token reuse detected. Session revoked.", { accountId: payload.account_id, sessionId: session.id });
    recordAudit({ action: "auth.refresh.reuse_detected", result: "denied", ...actor, metadata: { session_revoked: true } });
    throw invalid;
  }

  const account = await requireActiveAccount(payload.account_id, new ApiError(423, "ACCOUNT_INACTIVE", "Account is inactive."));
  const { permissions: _permissions, ...tokens } = await issueTokens(account, session.id, session.refresh_token_hash);

  recordAudit({ action: "auth.refresh.success", result: "success", ...actor, actor_username: account.username });
  return tokens;
}

// Function logout (revoke session ปัจจุบัน access/refresh token ของ session นี้ใช้ไม่ได้ทันที)
export async function logout(auth: AccessTokenPayload): Promise<{ message: string }> {
  await sessionRepository.revoke(auth.session_id, "logout");
  recordAudit({ action: "auth.logout", result: "success" });

  return { message: "Logged out successfully." };
}

// Function ดึงข้อมูลตัวเองพร้อมสิทธิ์ล่าสุดจาก DB
export async function me(auth: AccessTokenPayload): Promise<MeResponse> {
  const account = await requireActiveAccount(auth.account_id, new ApiError(401, "INVALID_TOKEN", "Invalid or expired token."));

  return { ...toAccountDto(account), permissions: await accountRepository.listPermissions(account.id) };
}

// Function เปลี่ยนรหัสผ่านของตัวเอง (session ปัจจุบันใช้ต่อได้)
export async function changeOwnPassword(auth: AccessTokenPayload, body: unknown): Promise<{ message: string }> {
  const { current_password: currentPassword, new_password: newPassword } = parseWithSchema(changeOwnPasswordBodySchema, body);
  const account = await requireActiveAccount(auth.account_id, new ApiError(401, "INVALID_TOKEN", "Invalid or expired token."));

  if (!(await verifyPassword(currentPassword, account.password_hash))) {
    recordAudit({ action: "auth.password.change_failed", result: "failure", actor_username: account.username, metadata: { reason: "invalid_current_password" } });
    throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect.");
  }

  await accountRepository.updateAccount(account.id, { password_hash: await hashPassword(newPassword) });
  recordAudit({ action: "auth.password.changed", result: "success", actor_username: account.username, target_type: "account", target_id: account.id });

  return { message: "Password changed successfully." };
}
