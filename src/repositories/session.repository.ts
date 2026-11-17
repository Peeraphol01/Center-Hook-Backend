// Import Library
import type { UserSession } from "@prisma/client";
// Import Config
import { prisma, type DbClient } from "../config/database";
// Import Types
import type { RequestMeta, SessionRecord } from "../types/auth.types";

/* -------------------------------------- Config -------------------------------------- */

// Config ค่าชั่วคราวของ refresh_token_hash ระหว่างสร้าง session (ต้องรู้ id ก่อนจึงเซ็น token ได้)
const PENDING_HASH = "pending";

/* -------------------------------------- Helpers -------------------------------------- */

// Function แปลง Prisma UserSession เป็น SessionRecord
function mapSession(session: UserSession): SessionRecord {
  return {
    id: session.id,
    account_id: session.accountId,
    refresh_token_hash: session.refreshTokenHash,
    is_active: session.isActive,
    last_active_at: session.lastActiveAt.toISOString(),
    expires_at: session.expiresAt.toISOString(),
  };
}

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง session ใหม่ (refresh_token_hash ใส่ทีหลังด้วย rotateRefreshTokenHash)
export async function createSession(accountId: number, expiresAt: Date, meta: RequestMeta, db: DbClient = prisma): Promise<SessionRecord> {
  const session = await db.userSession.create({
    data: {
      accountId,
      refreshTokenHash: PENDING_HASH,
      ipAddress: meta.ip_address?.slice(0, 64) ?? null,
      userAgent: meta.user_agent?.slice(0, 512) ?? null,
      expiresAt,
    },
  });

  return mapSession(session);
}

// Function ดึง session ที่ยังใช้ได้ (active และยังไม่หมดอายุ) ไม่ผ่านคืน null
export async function findActiveById(id: number, db: DbClient = prisma): Promise<SessionRecord | null> {
  const session = await db.userSession.findUnique({ where: { id } });

  if (!session || !session.isActive || session.expiresAt.getTime() <= Date.now()) {
    return null;
  }

  return mapSession(session);
}

// Function เปลี่ยน hash ของ refresh token แบบ compare-and-set (hash เดิมไม่ตรง = มีคนใช้ token นี้ refresh ไปก่อนแล้ว คืน false)
export async function rotateRefreshTokenHash(id: number, nextHash: string, expectedHash: string, db: DbClient = prisma): Promise<boolean> {
  const result = await db.userSession.updateMany({
    where: { id, isActive: true, refreshTokenHash: expectedHash },
    data: { refreshTokenHash: nextHash, lastActiveAt: new Date() },
  });

  return result.count > 0;
}

// Function revoke session เดียว
export async function revoke(id: number, db: DbClient = prisma): Promise<void> {
  await db.userSession.updateMany({ where: { id, isActive: true }, data: { isActive: false, revokedAt: new Date() } });
}

// Function revoke ทุก session ที่ยัง active ของบัญชี คืนจำนวนที่ revoke
export async function revokeAllByAccountId(accountId: number, db: DbClient = prisma): Promise<number> {
  const result = await db.userSession.updateMany({
    where: { accountId, isActive: true },
    data: { isActive: false, revokedAt: new Date() },
  });

  return result.count;
}
