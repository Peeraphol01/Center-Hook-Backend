// Import Library
import type { Account } from "@prisma/client";
// Import Config
import { prisma, type DbClient } from "../config/database";
import { isPermission, type Permission, type Role } from "../config/permission.config";
// Import Types
import type { AccountRecord, AccountStatus } from "../types/auth.types";

/* -------------------------------------- Helpers -------------------------------------- */

// Function แปลง Prisma Account เป็น AccountRecord
function mapAccount(account: Account): AccountRecord {
  return {
    id: account.id,
    username: account.username,
    password_hash: account.passwordHash,
    role: account.role as Role,
    status: account.status as AccountStatus,
    full_name: account.fullName,
    failed_login_count: account.failedLoginCount,
    locked_until: account.lockedUntil?.toISOString() ?? null,
    created_by: account.createdBy,
    created_at: account.createdAt.toISOString(),
    updated_at: account.updatedAt.toISOString(),
  };
}

/* -------------------------------------- Accounts -------------------------------------- */

// Function ดึงบัญชีตาม id
export async function findById(id: number, db: DbClient = prisma): Promise<AccountRecord | null> {
  const account = await db.account.findUnique({ where: { id } });

  return account ? mapAccount(account) : null;
}

// Function ดึงบัญชีตาม username
export async function findByUsername(username: string, db: DbClient = prisma): Promise<AccountRecord | null> {
  const account = await db.account.findUnique({ where: { username } });

  return account ? mapAccount(account) : null;
}

// Function ดึงบัญชีทั้งหมด เรียงตาม id
export async function listAccounts(db: DbClient = prisma): Promise<AccountRecord[]> {
  const accounts = await db.account.findMany({ orderBy: { id: "asc" } });

  return accounts.map(mapAccount);
}

// Function lock แถวบัญชีจนจบ transaction (กันสองคนแก้บัญชีเดียวกันพร้อมกัน / login ซ้อนกัน)
export async function lockById(id: number, tx: DbClient): Promise<void> {
  await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${id} FOR UPDATE`;
}

// Function สร้างบัญชี (username ซ้ำ Prisma โยน P2002)
export async function createAccount(
  input: { username: string; password_hash: string; role: Role; status: AccountStatus; full_name: string; created_by: number | null },
  db: DbClient = prisma
): Promise<AccountRecord> {
  const account = await db.account.create({
    data: {
      username: input.username,
      passwordHash: input.password_hash,
      role: input.role,
      status: input.status,
      fullName: input.full_name,
      createdBy: input.created_by,
    },
  });

  return mapAccount(account);
}

// Function แก้ข้อมูลบัญชี (ส่งเฉพาะ field ที่ต้องการเปลี่ยน)
export async function updateAccount(
  id: number,
  input: { full_name?: string; role?: Role; status?: AccountStatus; password_hash?: string },
  db: DbClient = prisma
): Promise<AccountRecord> {
  const account = await db.account.update({
    where: { id },
    data: {
      ...(input.full_name !== undefined && { fullName: input.full_name }),
      ...(input.role !== undefined && { role: input.role }),
      ...(input.status !== undefined && { status: input.status }),
      ...(input.password_hash !== undefined && { passwordHash: input.password_hash }),
    },
  });

  return mapAccount(account);
}

// Function เพิ่มตัวนับรหัสผิดแบบ atomic (กันยิงพร้อมกันแล้วนับหาย) คืนค่าหลังเพิ่ม
export async function incrementFailedLogin(id: number, db: DbClient = prisma): Promise<number> {
  const account = await db.account.update({ where: { id }, data: { failedLoginCount: { increment: 1 } } });

  return account.failedLoginCount;
}

// Function ล็อกบัญชีถึงเวลาที่กำหนด และเริ่มนับรหัสผิดใหม่ (หมดเวลาล็อกได้ลองครบจำนวนอีกรอบ)
export async function lockAccount(id: number, until: Date, db: DbClient = prisma): Promise<void> {
  await db.account.update({ where: { id }, data: { lockedUntil: until, failedLoginCount: 0 } });
}

// Function ล้างตัวนับรหัสผิดและการล็อก (login สำเร็จ)
export async function clearLoginFailures(id: number, db: DbClient = prisma): Promise<void> {
  await db.account.update({ where: { id }, data: { failedLoginCount: 0, lockedUntil: null } });
}

// Function ลบบัญชี (สิทธิ์และ session ลบตามด้วย ON DELETE CASCADE)
export async function deleteAccount(id: number, db: DbClient = prisma): Promise<boolean> {
  const result = await db.account.deleteMany({ where: { id } });

  return result.count > 0;
}

/* -------------------------------------- Permissions -------------------------------------- */

// Function ดึงสิทธิ์ของบัญชีจาก DB (ข้ามชื่อที่ระบบไม่รู้จักแล้ว)
export async function listPermissions(accountId: number, db: DbClient = prisma): Promise<Permission[]> {
  const rows = await db.accountPermission.findMany({ where: { accountId }, orderBy: { permission: "asc" } });

  return rows.map((row) => row.permission).filter(isPermission);
}

// Function แทนที่สิทธิ์ทั้งหมดของบัญชีด้วยชุดใหม่
export async function replacePermissions(accountId: number, permissions: readonly Permission[], db: DbClient = prisma): Promise<void> {
  await db.accountPermission.deleteMany({ where: { accountId } });

  if (permissions.length > 0) {
    await db.accountPermission.createMany({
      data: permissions.map((permission) => ({ accountId, permission })),
      skipDuplicates: true,
    });
  }
}
