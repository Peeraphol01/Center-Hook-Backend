// Import Config
import { withTransaction } from "../config/database";
import { canManageRole, findMissingDependencies, type Permission, type Role } from "../config/permission.config";
// Import Repositories
import * as accountRepository from "../repositories/account.repository";
import * as sessionRepository from "../repositories/session.repository";
// Import Services
import { toAccountDto } from "./auth.service";
// Import Types
import type { AccessTokenPayload, AccountDto, AccountRecord, MeResponse } from "../types/auth.types";
// Import Utils
import { ApiError, parseWithSchema } from "../utils/api-helper";
import { logger } from "../utils/logger";
import { hashPassword } from "../utils/password";
// Import Validations
import { accountIdParamSchema, createAdminBodySchema, resetAdminPasswordBodySchema, updateAdminBodySchema } from "../validations/admin.schema";

/* -------------------------------------- Types -------------------------------------- */

// Type ส่วน DTO ของบัญชีในหน้ารายการ (can_manage = ผู้เรียกแก้/ลบบัญชีนี้ได้หรือไม่)
type AdminListItem = AccountDto & { can_manage: boolean };

/* -------------------------------------- Rules -------------------------------------- */

// Function ดึงบัญชีของผู้ทำรายการจาก DB (ใช้ role/สิทธิ์ล่าสุด ไม่เชื่อค่าใน token อย่างเดียว)
async function requireActor(auth: AccessTokenPayload): Promise<AccountRecord> {
  const actor = await accountRepository.findById(auth.account_id);

  if (!actor || actor.status !== "active") {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  return actor;
}

// Function ดึงบัญชีเป้าหมายจาก id ใน path (รูปแบบผิด 400, ไม่พบ 404)
async function requireTarget(idParam: unknown): Promise<AccountRecord> {
  const id = parseWithSchema(accountIdParamSchema, idParam, { message: "Invalid id." });
  const target = await accountRepository.findById(id);

  if (!target) {
    throw new ApiError(404, "ADMIN_NOT_FOUND", "Admin account not found.");
  }

  return target;
}

// Function ตรวจว่าผู้ทำรายการจัดการบัญชีเป้าหมายได้ (ห้ามจัดการตัวเอง และห้ามจัดการ role เท่ากันหรือสูงกว่า)
function assertCanManageTarget(actor: AccountRecord, target: AccountRecord): void {
  if (actor.id === target.id) {
    throw new ApiError(403, "CANNOT_MANAGE_OWN_ACCOUNT", "Cannot manage your own account here. Use /api/auth/me instead.");
  }

  if (!canManageRole(actor.role, target.role)) {
    throw new ApiError(403, "TARGET_ROLE_NOT_MANAGEABLE", "Cannot manage an account with an equal or higher role.");
  }
}

// Function ตรวจว่ากำหนด role นี้ให้คนอื่นได้ (ต้องต่ำกว่า role ของผู้ทำรายการ)
function assertCanAssignRole(actor: AccountRecord, role: Role): void {
  if (!canManageRole(actor.role, role)) {
    throw new ApiError(403, "ROLE_NOT_ASSIGNABLE", "Cannot assign an equal or higher role.");
  }
}

// Function ตรวจชุดสิทธิ์ที่จะให้: ต้องเป็นสิทธิ์ที่ผู้ทำรายการมีอยู่จริง และครบตาม dependency
async function assertPermissionsGrantable(actor: AccountRecord, requested: readonly Permission[]): Promise<void> {
  const actorPermissions = new Set(await accountRepository.listPermissions(actor.id));
  const ungrantable = requested.filter((permission) => !actorPermissions.has(permission));

  if (ungrantable.length > 0) {
    throw new ApiError(403, "PERMISSIONS_NOT_GRANTABLE", `Cannot grant permissions you do not have: ${ungrantable.join(", ")}`, {
      permissions: ungrantable,
    });
  }

  const missing = findMissingDependencies(requested);

  if (missing.length > 0) {
    throw new ApiError(400, "PERMISSION_DEPENDENCY_NOT_SATISFIED", `Missing required permissions: ${missing.join(", ")}`, {
      permissions: missing,
    });
  }
}

// Function แปลง error ของ Prisma (username ซ้ำ = 409, ไม่พบ = 404)
function toApiError(error: unknown): unknown {
  const code = (error as { code?: unknown })?.code;

  if (code === "P2002") {
    return new ApiError(409, "USERNAME_ALREADY_EXISTS", "Username already exists.");
  }

  if (code === "P2025") {
    return new ApiError(404, "ADMIN_NOT_FOUND", "Admin account not found.");
  }

  return error;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงรายการบัญชีทั้งหมด พร้อมบอกว่าผู้เรียกจัดการบัญชีไหนได้
export async function listAdmins(auth: AccessTokenPayload): Promise<{ data: AdminListItem[] }> {
  const actor = await requireActor(auth);
  const accounts = await accountRepository.listAccounts();

  return {
    data: accounts.map((account) => ({
      ...toAccountDto(account),
      can_manage: account.id !== actor.id && canManageRole(actor.role, account.role),
    })),
  };
}

// Function ดึงบัญชีเดียวพร้อมสิทธิ์ (ดูได้เฉพาะ role ที่ต่ำกว่า ของตัวเองดูที่ /api/auth/me)
export async function getAdmin(idParam: unknown, auth: AccessTokenPayload): Promise<MeResponse> {
  const target = await requireTarget(idParam);

  assertCanManageTarget(await requireActor(auth), target);

  return { ...toAccountDto(target), permissions: await accountRepository.listPermissions(target.id) };
}

// Function สร้างบัญชีใหม่ (role ต้องต่ำกว่าผู้สร้าง และให้ได้เฉพาะสิทธิ์ที่ผู้สร้างมี)
export async function createAdmin(body: unknown, auth: AccessTokenPayload): Promise<MeResponse> {
  const input = parseWithSchema(createAdminBodySchema, body);
  const actor = await requireActor(auth);

  assertCanAssignRole(actor, input.role);
  await assertPermissionsGrantable(actor, input.permissions);

  const passwordHash = await hashPassword(input.password);

  try {
    const account = await withTransaction(async (tx) => {
      const created = await accountRepository.createAccount(
        { username: input.username, password_hash: passwordHash, role: input.role, status: input.status, full_name: input.full_name, created_by: actor.id },
        tx
      );

      await accountRepository.replacePermissions(created.id, input.permissions, tx);
      return created;
    });

    logger.info("Admin account created.", { actorId: actor.id, accountId: account.id, role: account.role, permissions: input.permissions });
    return { ...toAccountDto(account), permissions: input.permissions };
  } catch (error) {
    throw toApiError(error);
  }
}

// Function แก้บัญชี (ชื่อ, role, สถานะ, สิทธิ์) เปลี่ยน role/สถานะ/สิทธิ์แล้ว revoke session ให้ login ใหม่ด้วยสิทธิ์ใหม่
export async function updateAdmin(idParam: unknown, body: unknown, auth: AccessTokenPayload): Promise<MeResponse & { message: string }> {
  const target = await requireTarget(idParam);
  const input = parseWithSchema(updateAdminBodySchema, body);
  const actor = await requireActor(auth);

  assertCanManageTarget(actor, target);

  if (input.role !== undefined) {
    assertCanAssignRole(actor, input.role);
  }

  if (input.permissions !== undefined) {
    await assertPermissionsGrantable(actor, input.permissions);
  }

  const result = await withTransaction(async (tx) => {
    // lock เป้าหมายแล้วเช็คซ้ำ กันสองคนแก้บัญชีเดียวกันพร้อมกัน (เช่นอีกคนเพิ่งเลื่อน role ขึ้น)
    await accountRepository.lockById(target.id, tx);
    const fresh = await accountRepository.findById(target.id, tx);

    if (!fresh) {
      throw new ApiError(404, "ADMIN_NOT_FOUND", "Admin account not found.");
    }

    assertCanManageTarget(actor, fresh);

    const currentPermissions = await accountRepository.listPermissions(fresh.id, tx);
    const updated = await accountRepository.updateAccount(fresh.id, { full_name: input.full_name, role: input.role, status: input.status }, tx);

    if (input.permissions !== undefined) {
      await accountRepository.replacePermissions(fresh.id, input.permissions, tx);
    }

    const nextPermissions = input.permissions ?? currentPermissions;
    const accessChanged =
      updated.role !== fresh.role || updated.status !== fresh.status || nextPermissions.join(",") !== currentPermissions.join(",");
    const revoked = accessChanged ? await sessionRepository.revokeAllByAccountId(fresh.id, tx) : 0;

    return { updated, permissions: nextPermissions, revoked };
  });

  logger.info("Admin account updated.", { actorId: actor.id, accountId: target.id, changes: input, revokedSessions: result.revoked });

  return {
    message: result.revoked > 0 ? "Admin account updated. Active sessions were revoked." : "Admin account updated.",
    ...toAccountDto(result.updated),
    permissions: result.permissions,
  };
}

// Function ตั้งรหัสผ่านใหม่ให้บัญชีอื่น แล้ว revoke ทุก session ของบัญชีนั้น
export async function resetAdminPassword(idParam: unknown, body: unknown, auth: AccessTokenPayload): Promise<{ message: string }> {
  const target = await requireTarget(idParam);
  const { new_password: newPassword } = parseWithSchema(resetAdminPasswordBodySchema, body);
  const actor = await requireActor(auth);

  assertCanManageTarget(actor, target);

  const passwordHash = await hashPassword(newPassword);

  await withTransaction(async (tx) => {
    await accountRepository.updateAccount(target.id, { password_hash: passwordHash }, tx);
    // ตั้งรหัสใหม่ให้แล้ว = ปลดล็อกจากการใส่รหัสผิดด้วย
    await accountRepository.clearLoginFailures(target.id, tx);
    await sessionRepository.revokeAllByAccountId(target.id, tx);
  });

  logger.info("Admin password reset.", { actorId: actor.id, accountId: target.id });
  return { message: "Password reset successfully. Active sessions were revoked." };
}

// Function ปลดล็อกบัญชีที่ถูกล็อกจากการใส่รหัสผิด (ล้างตัวนับด้วย ล็อกอยู่หรือไม่ก็เรียกได้)
export async function unlockAdmin(idParam: unknown, auth: AccessTokenPayload): Promise<MeResponse & { message: string }> {
  const target = await requireTarget(idParam);
  const actor = await requireActor(auth);

  assertCanManageTarget(actor, target);
  await accountRepository.clearLoginFailures(target.id);

  const updated = (await accountRepository.findById(target.id)) ?? target;

  logger.info("Admin account unlocked.", { actorId: actor.id, accountId: target.id });
  return {
    message: "Admin account unlocked.",
    ...toAccountDto(updated),
    permissions: await accountRepository.listPermissions(target.id),
  };
}

// Function ลบบัญชี (สิทธิ์และ session ลบตามไปด้วย)
export async function deleteAdmin(idParam: unknown, auth: AccessTokenPayload): Promise<{ message: string }> {
  const target = await requireTarget(idParam);
  const actor = await requireActor(auth);

  assertCanManageTarget(actor, target);

  if (!(await accountRepository.deleteAccount(target.id))) {
    throw new ApiError(404, "ADMIN_NOT_FOUND", "Admin account not found.");
  }

  logger.info("Admin account deleted.", { actorId: actor.id, accountId: target.id, username: target.username });
  return { message: "Admin account deleted." };
}
