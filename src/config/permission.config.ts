/* -------------------------------------- Types -------------------------------------- */

// Type สิทธิ์แต่ละรายการของบัญชีผู้ดูแล
export type Permission = (typeof PERMISSIONS)[number];

// Type role ของบัญชีผู้ดูแล
export type Role = (typeof ROLES)[number];

/* -------------------------------------- Config -------------------------------------- */

// Config รายการสิทธิ์ทั้งหมดที่ระบบรู้จัก (สิทธิ์ที่แต่ละบัญชีมีจริงเก็บในตาราง account_permissions)
export const PERMISSIONS = [
  "forward_logs:read",
  "webhooks:read",
  "webhooks:create",
  "webhooks:update",
  "webhooks:delete",
  "admins:read",
  "admins:create",
  "admins:update",
  "admins:delete",
  "admins:reset_password",
] as const;

// Config dependency ของสิทธิ์ (ให้สิทธิ์นี้ต้องให้สิทธิ์ที่ระบุด้วย เช่น สร้างต้องดูได้)
export const PERMISSION_DEPENDENCIES: Partial<Record<Permission, readonly Permission[]>> = {
  "webhooks:create": ["webhooks:read"],
  "webhooks:update": ["webhooks:read"],
  "webhooks:delete": ["webhooks:read"],
  "admins:create": ["admins:read"],
  "admins:update": ["admins:read"],
  "admins:delete": ["admins:read"],
  "admins:reset_password": ["admins:read"],
};

// Config role เรียงจากสูงไปต่ำ (จัดการได้เฉพาะ role ที่ต่ำกว่าตัวเองเท่านั้น)
export const ROLES = ["owner", "manager", "admin"] as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า value เป็นชื่อสิทธิ์ที่ระบบรู้จัก
export function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

// Function คืนลำดับของ role (ยิ่งน้อยยิ่งสูง, -1 ถ้าไม่รู้จัก)
export function getRoleOrder(role: string | null | undefined): number {
  return ROLES.findIndex((item) => item === role);
}

// Function ตรวจว่า actorRole สูงกว่า targetRole (เท่ากันหรือต่ำกว่าจัดการไม่ได้)
export function canManageRole(actorRole: string | null | undefined, targetRole: string | null | undefined): boolean {
  const actorOrder = getRoleOrder(actorRole);
  const targetOrder = getRoleOrder(targetRole);

  return actorOrder >= 0 && targetOrder >= 0 && actorOrder < targetOrder;
}

// Function คืนสิทธิ์ที่ขาดตาม dependency (ว่าง = ครบ)
export function findMissingDependencies(permissions: readonly Permission[]): Permission[] {
  const requested = new Set(permissions);
  const missing = new Set<Permission>();

  for (const permission of permissions) {
    for (const dependency of PERMISSION_DEPENDENCIES[permission] ?? []) {
      if (!requested.has(dependency)) {
        missing.add(dependency);
      }
    }
  }

  return [...missing];
}
