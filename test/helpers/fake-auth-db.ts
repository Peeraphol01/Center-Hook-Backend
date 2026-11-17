// Import Library
import argon2 from "argon2";

/* -------------------------------------- Config -------------------------------------- */

// Config env ของระบบ login ที่ test ทุกไฟล์ต้องตั้งก่อนโหลด app
export const TEST_AUTH_ENV = {
  JWT_ACCESS_SECRET: "test-access-secret-0123456789-abcdefghijklmnop",
  JWT_REFRESH_SECRET: "test-refresh-secret-0123456789-abcdefghijklmnop",
  REFRESH_TOKEN_HASH_SECRET: "test-refresh-hash-secret-0123456789-abcdefghij",
};

// Config hash ของรหัสผ่านที่ใช้ใน test (hash ครั้งเดียวด้วย cost ต่ำ ให้ test เร็ว)
export const TEST_PASSWORD = "Passw0rd!";

// Config รหัสเครื่องตั้งต้นของ test (login ซ้ำจากเครื่องเดียวกัน = แทน session เดิมโดยไม่ถาม)
export const TEST_DEVICE_ID = "test-device-0000000000000001";
const passwordHashPromise = argon2.hash(TEST_PASSWORD, { type: argon2.argon2id, memoryCost: 1024, timeCost: 1, parallelism: 1 });

/* -------------------------------------- Types -------------------------------------- */

// Type แถวในตารางปลอม (ชื่อ field แบบ Prisma)
export type FakeAccount = {
  id: number; username: string; passwordHash: string; role: string; status: string; fullName: string;
  failedLoginCount: number; lockedUntil: Date | null; createdBy: number | null; createdAt: Date; updatedAt: Date;
};
type FakePermission = { id: number; accountId: number; permission: string; createdAt: Date };
type FakeSession = {
  id: number; accountId: number; refreshTokenHash: string; ipAddress: string | null; userAgent: string | null; isActive: boolean;
  deviceId?: string | null; lastActiveAt: Date; expiresAt: Date; revokedAt: Date | null; revokeReason?: string | null; createdAt: Date; updatedAt: Date;
};

// Type แถวของ audit_logs (ชื่อ field แบบ Prisma)
export type FakeAuditLog = Record<string, unknown> & { id: bigint; occurredAt: Date; action: string };

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจเงื่อนไขของ field เดียวแบบ Prisma (เท่ากัน, in, not, startsWith, gte/lte/lt)
function matchesCondition(value: unknown, condition: unknown): boolean {
  if (condition === undefined) return true;
  if (condition === null || typeof condition !== "object" || condition instanceof Date) {
    return condition instanceof Date ? value instanceof Date && value.getTime() === condition.getTime() : value === condition;
  }
  const { in: inList, not, startsWith, gte, lte, lt } = condition as Record<string, unknown>;
  return (inList === undefined || (inList as unknown[]).includes(value))
    && (not === undefined || value !== not)
    && (startsWith === undefined || (typeof value === "string" && value.startsWith(startsWith as string)))
    && (gte === undefined || (value as Date) >= (gte as Date))
    && (lte === undefined || (value as Date) <= (lte as Date))
    && (lt === undefined || (value as Date) < (lt as Date));
}

// Function ตรวจ where แบบ Prisma ที่รองรับ AND (ใช้กับ audit_logs)
export function matchesWhere(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) =>
    key === "AND" ? (condition as Record<string, unknown>[]).every((part) => matchesWhere(row, part)) : matchesCondition(row[key], condition)
  );
}

// Function ตรวจว่าแถวตรง where แบบเท่ากันทุก field (พอสำหรับ query ที่ repository ใช้)
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, value]) => value === undefined || row[key] === value);
}

// Function สร้างฐานข้อมูลปลอมของ accounts / account_permissions / user_sessions
export function createFakeAuthDb() {
  const state = {
    accounts: [] as FakeAccount[],
    permissions: [] as FakePermission[],
    sessions: [] as FakeSession[],
    auditLogs: [] as FakeAuditLog[],
    nextId: 1,
    nextAuditId: 1n,
  };
  const nextId = () => state.nextId++;

  const account = {
    findUnique: async ({ where }: { where: { id?: number; username?: string } }) =>
      state.accounts.find((row) => (where.id !== undefined ? row.id === where.id : row.username === where.username)) ?? null,
    findMany: async () => [...state.accounts].sort((a, b) => a.id - b.id),
    create: async ({ data }: { data: Omit<FakeAccount, "id" | "createdAt" | "updatedAt" | "createdBy" | "failedLoginCount" | "lockedUntil"> & { createdBy?: number | null } }) => {
      if (state.accounts.some((row) => row.username === data.username)) {
        throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
      }
      const row = { createdBy: null, failedLoginCount: 0, lockedUntil: null, ...data, id: nextId(), createdAt: new Date(), updatedAt: new Date() };
      state.accounts.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const row = state.accounts.find((item) => item.id === where.id) as Record<string, unknown> | undefined;
      if (!row) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      for (const [key, value] of Object.entries(data)) {
        // รองรับ { increment: n } แบบ Prisma
        row[key] = value && typeof value === "object" && "increment" in value ? Number(row[key]) + Number((value as { increment: number }).increment) : value;
      }
      row.updatedAt = new Date();
      return row as FakeAccount;
    },
    deleteMany: async ({ where }: { where: { id: number } }) => {
      const before = state.accounts.length;
      state.accounts = state.accounts.filter((row) => row.id !== where.id);
      // จำลอง ON DELETE CASCADE
      state.permissions = state.permissions.filter((row) => row.accountId !== where.id);
      state.sessions = state.sessions.filter((row) => row.accountId !== where.id);
      return { count: before - state.accounts.length };
    },
  };

  const accountPermission = {
    findMany: async ({ where }: { where: { accountId: number } }) =>
      state.permissions.filter((row) => row.accountId === where.accountId).sort((a, b) => a.permission.localeCompare(b.permission)),
    deleteMany: async ({ where }: { where: { accountId: number } }) => {
      const before = state.permissions.length;
      state.permissions = state.permissions.filter((row) => row.accountId !== where.accountId);
      return { count: before - state.permissions.length };
    },
    createMany: async ({ data }: { data: { accountId: number; permission: string }[] }) => {
      for (const item of data) state.permissions.push({ ...item, id: nextId(), createdAt: new Date() });
      return { count: data.length };
    },
  };

  const userSession = {
    create: async ({ data }: { data: Pick<FakeSession, "accountId" | "refreshTokenHash" | "ipAddress" | "userAgent" | "expiresAt"> }) => {
      const now = new Date();
      const row = { deviceId: null, ...data, id: nextId(), isActive: true, lastActiveAt: now, revokedAt: null, revokeReason: null, createdAt: now, updatedAt: now };
      state.sessions.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: number } }) => state.sessions.find((row) => row.id === where.id) ?? null,
    findFirst: async ({ where }: { where: Record<string, unknown> }) => state.sessions.find((row) => matchesWhere(row, where)) ?? null,
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      state.sessions.filter((row) => matchesWhere(row, where)).sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime()),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<FakeSession> }) => {
      const rows = state.sessions.filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
      return { count: rows.length };
    },
  };

  const sortDesc = (rows: FakeAuditLog[]) => [...rows].sort((a, b) => Number(b.id - a.id));
  const auditLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row = { severity: "info", ...data, id: state.nextAuditId++, occurredAt: new Date() } as unknown as FakeAuditLog;
      state.auditLogs.push(row);
      return row;
    },
    findMany: async ({ where, skip = 0, take }: { where?: Record<string, unknown>; skip?: number; take?: number }) =>
      sortDesc(state.auditLogs.filter((row) => matchesWhere(row, where))).slice(skip, take === undefined ? undefined : skip + take),
    count: async ({ where }: { where?: Record<string, unknown> }) => state.auditLogs.filter((row) => matchesWhere(row, where)).length,
    findUnique: async ({ where }: { where: { id: bigint } }) => state.auditLogs.find((row) => row.id === where.id) ?? null,
    groupBy: async ({ by, where, take }: { by: string[]; where?: Record<string, unknown>; take?: number }) => {
      const counts = new Map<unknown, number>();
      for (const row of state.auditLogs.filter((item) => matchesWhere(item, where))) {
        counts.set(row[by[0]], (counts.get(row[by[0]]) ?? 0) + 1);
      }
      return [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, take)
        .map(([value, count]) => ({ [by[0]]: value, _count: { _all: count } }));
    },
    deleteMany: async ({ where }: { where?: Record<string, unknown> }) => {
      const before = state.auditLogs.length;
      state.auditLogs = state.auditLogs.filter((row) => !matchesWhere(row, where));
      return { count: before - state.auditLogs.length };
    },
  };

  return {
    state,
    delegates: { account, accountPermission, userSession, auditLog, $queryRaw: async () => [] },
    reset(): void {
      state.auditLogs = [];
      state.nextAuditId = 1n;
      state.accounts = [];
      state.permissions = [];
      state.sessions = [];
      state.nextId = 1;
    },
    // Function เพิ่มบัญชีพร้อมสิทธิ์ลงฐานข้อมูลปลอม (รหัสผ่าน = TEST_PASSWORD)
    async seedAccount(input: { username?: string; role: string; permissions?: readonly string[]; status?: string }): Promise<FakeAccount> {
      const row = await account.create({
        data: {
          username: input.username ?? input.role,
          passwordHash: await passwordHashPromise,
          role: input.role,
          status: input.status ?? "active",
          fullName: `Test ${input.role}`,
        },
      });
      await accountPermission.createMany({ data: (input.permissions ?? []).map((permission) => ({ accountId: row.id, permission })) });
      return row;
    },
  };
}

// Type ฐานข้อมูลปลอมของระบบ login
export type FakeAuthDb = ReturnType<typeof createFakeAuthDb>;

// Function login ผ่าน API จริงแล้วคืน header Authorization (ใช้กับ app ที่โหลดแล้ว)
export async function loginHeaders(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  username: string
): Promise<Record<string, string>> {
  const response = await app.request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: TEST_PASSWORD, device_id: TEST_DEVICE_ID }),
  });

  if (response.status !== 200) {
    throw new Error(`login as ${username} failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { access_token: string };
  return { authorization: `Bearer ${body.access_token}` };
}
