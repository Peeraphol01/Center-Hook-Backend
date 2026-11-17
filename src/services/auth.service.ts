// Import Config
import { getAccessTokenExpiresInSeconds, getLoginLockoutConfig, getRefreshTokenExpiresInSeconds } from "../config/auth.config";
import { withTransaction, type DbClient } from "../config/database";
// Import Repositories
import * as accountRepository from "../repositories/account.repository";
import * as sessionRepository from "../repositories/session.repository";
// Import Types
import type { AccessTokenPayload, AccountDto, AccountRecord, LoginResponse, MeResponse, RequestMeta, TokenResponse } from "../types/auth.types";
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

// Function ดึงบัญชีที่ยัง active ไม่ผ่าน throw ตาม error ที่ส่งมา
async function requireActiveAccount(accountId: number, error: ApiError): Promise<AccountRecord> {
  const account = await accountRepository.findById(accountId);

  if (!account || account.status !== "active") {
    throw error;
  }

  return account;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function login ด้วย username/password (หนึ่งบัญชีมีได้ session เดียว login ใหม่ = session เก่าใช้ไม่ได้ทันที)
export async function login(body: unknown, meta: RequestMeta): Promise<LoginResponse> {
  const { username, password } = parseWithSchema(loginBodySchema, body);
  const account = await accountRepository.findByUsername(username);

  // ล็อกอยู่ = ไม่ตรวจรหัสเลย (รหัสถูกก็เข้าไม่ได้จนหมดเวลา)
  if (account && getLockRemainingMs(account) > 0) {
    throw accountLockedError(account.locked_until as string);
  }

  const passwordValid = await verifyPassword(password, account?.password_hash ?? (await getDummyHash()));

  if (!account || !passwordValid || account.status !== "active") {
    logger.warn("Login failed.", { username, reason: !account ? "unknown_username" : !passwordValid ? "invalid_password" : "account_inactive" });

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

    // login สำเร็จ = เริ่มนับรหัสผิดใหม่
    if (locked.failed_login_count > 0 || locked.locked_until) {
      await accountRepository.clearLoginFailures(locked.id, tx);
    }

    await sessionRepository.revokeAllByAccountId(locked.id, tx);

    const session = await sessionRepository.createSession(locked.id, new Date(Date.now() + getRefreshTokenExpiresInSeconds() * 1000), meta, tx);
    const { permissions, ...tokens } = await issueTokens(locked, session.id, session.refresh_token_hash, tx);

    return { ...tokens, profile: { ...toAccountDto(locked), permissions } };
  });

  logger.info("Login succeeded.", { accountId: account.id, username: account.username });
  return result;
}

// Function ออก token ชุดใหม่ด้วย refresh token (refresh token เดิมใช้ซ้ำไม่ได้ / สิทธิ์ใน access token อ่านจาก DB ใหม่)
export async function refresh(body: unknown): Promise<TokenResponse> {
  const { refresh_token: refreshToken } = parseWithSchema(refreshBodySchema, body);
  const payload = verifyRefreshToken(refreshToken);
  const session = await sessionRepository.findActiveById(payload.session_id);
  const invalid = new ApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");

  if (!session || session.account_id !== payload.account_id || !refreshTokenHashesMatch(hashRefreshToken(refreshToken), session.refresh_token_hash)) {
    throw invalid;
  }

  const account = await requireActiveAccount(payload.account_id, new ApiError(423, "ACCOUNT_INACTIVE", "Account is inactive."));
  const { permissions: _permissions, ...tokens } = await issueTokens(account, session.id, session.refresh_token_hash);

  return tokens;
}

// Function logout (revoke session ปัจจุบัน access/refresh token ของ session นี้ใช้ไม่ได้ทันที)
export async function logout(auth: AccessTokenPayload): Promise<{ message: string }> {
  await sessionRepository.revoke(auth.session_id);

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
    throw new ApiError(400, "INVALID_CURRENT_PASSWORD", "Current password is incorrect.");
  }

  await accountRepository.updateAccount(account.id, { password_hash: await hashPassword(newPassword) });

  return { message: "Password changed successfully." };
}
