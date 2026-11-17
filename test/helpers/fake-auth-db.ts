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
  lastActiveAt: Date; expiresAt: Date; revokedAt: Date | null; createdAt: Date; updatedAt: Date;
};

/* -------------------------------------- Functions -------------------------------------- */

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
    nextId: 1,
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
      const row = { ...data, id: nextId(), isActive: true, lastActiveAt: now, revokedAt: null, createdAt: now, updatedAt: now };
      state.sessions.push(row);
      return row;
    },
    findUnique: async ({ where }: { where: { id: number } }) => state.sessions.find((row) => row.id === where.id) ?? null,
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<FakeSession> }) => {
      const rows = state.sessions.filter((row) => matches(row, where));
      for (const row of rows) Object.assign(row, data, { updatedAt: new Date() });
      return { count: rows.length };
    },
  };

  return {
    state,
    delegates: { account, accountPermission, userSession, $queryRaw: async () => [] },
    reset(): void {
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
    body: JSON.stringify({ username, password: TEST_PASSWORD }),
  });

  if (response.status !== 200) {
    throw new Error(`login as ${username} failed: ${response.status} ${await response.text()}`);
  }

  const body = (await response.json()) as { access_token: string };
  return { authorization: `Bearer ${body.access_token}` };
}
