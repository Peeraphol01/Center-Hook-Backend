// Import Library
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
// Import Helpers
import { createFakeAuthDb, loginHeaders, TEST_AUTH_ENV, type FakeAccount } from "./helpers/fake-auth-db";

/* -------------------------------------- Setup -------------------------------------- */

// ตั้ง env ก่อนโหลด app (config อ่านค่าตอนโหลด module)
Object.assign(process.env, {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://test:test@localhost:5432/center_hook_test",
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX_REQUESTS: "1000",
  LOGIN_RATE_LIMIT_MAX_REQUESTS: "1000",
  ...TEST_AUTH_ENV,
});

const authDb = createFakeAuthDb();

class FakePrismaClient {
  account = authDb.delegates.account;
  accountPermission = authDb.delegates.accountPermission;
  userSession = authDb.delegates.userSession;
  auditLog = authDb.delegates.auditLog;
  $queryRaw = authDb.delegates.$queryRaw;
  $transaction = async <T>(work: (tx: this) => Promise<T>) => work(this);
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

const { default: app } = require("../src/app") as typeof import("../src/app");
const { PERMISSIONS } = require("../src/config/permission.config") as typeof import("../src/config/permission.config");

/* -------------------------------------- Test Helpers -------------------------------------- */

type ErrorBody = { code: string; permissions?: string[] };
type AccountBody = { id: number; username: string; role: string; status: string; full_name: string; permissions: string[]; message?: string };

const json = async <T>(response: Response) => (await response.json()) as T;

// Function เรียก API แบบ JSON
function call(method: string, path: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

// Function ตรวจ status และ code ของ error
async function expectError(response: Response, status: number, code: string): Promise<ErrorBody> {
  const body = await json<ErrorBody>(response);

  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.code, code);
  return body;
}

const NEW_ADMIN = { username: "somchai", password: "Somchai@123456", full_name: "สมชาย ใจดี", role: "admin", permissions: ["forward_logs:read"] };

/* -------------------------------------- Tests -------------------------------------- */

describe("/api/admins", () => {
  let owner: FakeAccount;
  let manager: FakeAccount;
  let admin: FakeAccount;
  let as: Record<"owner" | "manager" | "manager2" | "admin" | "limited", Record<string, string>>;

  beforeEach(async () => {
    authDb.reset();
    owner = await authDb.seedAccount({ username: "owner", role: "owner", permissions: PERMISSIONS });
    manager = await authDb.seedAccount({ username: "manager", role: "manager", permissions: PERMISSIONS });
    await authDb.seedAccount({ username: "manager2", role: "manager", permissions: PERMISSIONS });
    admin = await authDb.seedAccount({ username: "admin", role: "admin", permissions: ["forward_logs:read", "webhooks:read"] });
    // manager ที่มีสิทธิ์บางส่วน ใช้ทดสอบกฎ "ให้ได้เฉพาะสิทธิ์ที่ตัวเองมี"
    await authDb.seedAccount({ username: "limited", role: "manager", permissions: ["admins:read", "admins:create", "admins:update", "forward_logs:read"] });

    as = {
      owner: await loginHeaders(app, "owner"),
      manager: await loginHeaders(app, "manager"),
      manager2: await loginHeaders(app, "manager2"),
      admin: await loginHeaders(app, "admin"),
      limited: await loginHeaders(app, "limited"),
    };
  });

  describe("สิทธิ์ของ route", () => {
    it("ไม่มี token ตอบ 401 และไม่มีสิทธิ์ admins:* ตอบ 403 FORBIDDEN", async () => {
      assert.equal((await call("GET", "/api/admins", {})).status, 401);
      await expectError(await call("GET", "/api/admins", as.admin), 403, "FORBIDDEN");
      await expectError(await call("POST", "/api/admins", as.admin, NEW_ADMIN), 403, "FORBIDDEN");
      await expectError(await call("DELETE", `/api/admins/${owner.id}`, as.limited), 403, "FORBIDDEN");
    });
  });

  describe("GET /api/admins", () => {
    it("คืนทุกบัญชี ไม่มี password_hash และ can_manage ตามลำดับ role", async () => {
      const body = await json<{ data: (AccountBody & { can_manage: boolean })[] }>(await call("GET", "/api/admins", as.manager));
      const canManage = Object.fromEntries(body.data.map((item) => [item.username, item.can_manage]));

      assert.deepEqual(canManage, { owner: false, manager: false, manager2: false, admin: true, limited: false });
      assert.ok(body.data.every((item) => !("password_hash" in item)));
    });
  });

  describe("GET /api/admins/:id", () => {
    it("ดู role ที่ต่ำกว่าได้พร้อมสิทธิ์ ดู role เท่ากัน/สูงกว่าหรือตัวเองไม่ได้", async () => {
      const body = await json<AccountBody>(await call("GET", `/api/admins/${admin.id}`, as.manager));

      assert.deepEqual(body.permissions, ["forward_logs:read", "webhooks:read"]);
      await expectError(await call("GET", `/api/admins/${owner.id}`, as.manager), 403, "TARGET_ROLE_NOT_MANAGEABLE");
      await expectError(await call("GET", `/api/admins/${manager.id}`, as.manager), 403, "CANNOT_MANAGE_OWN_ACCOUNT");
      await expectError(await call("GET", "/api/admins/999", as.manager), 404, "ADMIN_NOT_FOUND");
      await expectError(await call("GET", "/api/admins/abc", as.manager), 400, "VALIDATION_ERROR");
    });
  });

  describe("POST /api/admins", () => {
    it("owner สร้าง manager ได้ และ manager สร้าง admin ได้ (login ด้วยบัญชีใหม่ได้ทันที)", async () => {
      const created = await call("POST", "/api/admins", as.owner, { ...NEW_ADMIN, username: "newmanager", role: "manager", permissions: ["admins:read", "webhooks:read"] });
      assert.equal(created.status, 201);
      assert.equal((await json<AccountBody>(created)).role, "manager");

      const response = await call("POST", "/api/admins", as.manager, NEW_ADMIN);
      const body = await json<AccountBody>(response);

      assert.equal(response.status, 201);
      assert.equal(body.role, "admin");
      assert.equal(body.status, "active");
      assert.deepEqual(body.permissions, ["forward_logs:read"]);
      assert.ok(!("password_hash" in body) && !("password" in body));

      const login = await call("POST", "/api/auth/login", {}, { username: NEW_ADMIN.username, password: NEW_ADMIN.password });
      assert.equal(login.status, 200);
    });

    it("สร้าง role เท่ากันหรือสูงกว่าตัวเองไม่ได้ (ROLE_NOT_ASSIGNABLE)", async () => {
      await expectError(await call("POST", "/api/admins", as.manager, { ...NEW_ADMIN, role: "manager" }), 403, "ROLE_NOT_ASSIGNABLE");
      await expectError(await call("POST", "/api/admins", as.manager, { ...NEW_ADMIN, role: "owner" }), 403, "ROLE_NOT_ASSIGNABLE");
      await expectError(await call("POST", "/api/admins", as.owner, { ...NEW_ADMIN, role: "owner" }), 403, "ROLE_NOT_ASSIGNABLE");
    });

    it("ให้สิทธิ์ที่ตัวเองไม่มีไม่ได้ (PERMISSIONS_NOT_GRANTABLE บอกรายการที่ให้ไม่ได้)", async () => {
      const body = await expectError(
        await call("POST", "/api/admins", as.limited, { ...NEW_ADMIN, permissions: ["forward_logs:read", "webhooks:read", "webhooks:delete"] }),
        403,
        "PERMISSIONS_NOT_GRANTABLE"
      );

      assert.deepEqual(body.permissions, ["webhooks:delete", "webhooks:read"]);
      assert.equal(authDb.state.accounts.some((account) => account.username === NEW_ADMIN.username), false);
    });

    it("สิทธิ์ขาด dependency ตอบ 400 PERMISSION_DEPENDENCY_NOT_SATISFIED", async () => {
      const body = await expectError(await call("POST", "/api/admins", as.owner, { ...NEW_ADMIN, permissions: ["webhooks:create"] }), 400, "PERMISSION_DEPENDENCY_NOT_SATISFIED");
      assert.deepEqual(body.permissions, ["webhooks:read"]);
    });

    it("ต้องระบุ permissions, สิทธิ์ที่ไม่รู้จักและ username ผิดรูปตอบ 400 / username ซ้ำตอบ 409", async () => {
      const { permissions: _permissions, ...withoutPermissions } = NEW_ADMIN;

      await expectError(await call("POST", "/api/admins", as.owner, withoutPermissions), 400, "VALIDATION_ERROR");
      await expectError(await call("POST", "/api/admins", as.owner, { ...NEW_ADMIN, permissions: ["root:all"] }), 400, "VALIDATION_ERROR");
      await expectError(await call("POST", "/api/admins", as.owner, { ...NEW_ADMIN, username: "a b" }), 400, "VALIDATION_ERROR");
      await expectError(await call("POST", "/api/admins", as.owner, { ...NEW_ADMIN, username: "admin" }), 409, "USERNAME_ALREADY_EXISTS");
    });
  });

  describe("PATCH /api/admins/:id", () => {
    it("แก้ role เท่ากัน/สูงกว่า หรือตัวเองไม่ได้", async () => {
      await expectError(await call("PATCH", `/api/admins/${owner.id}`, as.manager, { full_name: "x" }), 403, "TARGET_ROLE_NOT_MANAGEABLE");
      await expectError(await call("PATCH", `/api/admins/${manager.id}`, as.manager2, { full_name: "x" }), 403, "TARGET_ROLE_NOT_MANAGEABLE");
      await expectError(await call("PATCH", `/api/admins/${manager.id}`, as.manager, { full_name: "x" }), 403, "CANNOT_MANAGE_OWN_ACCOUNT");
    });

    it("เลื่อน role เป้าหมายขึ้นเท่ากับหรือสูงกว่าตัวเองไม่ได้", async () => {
      await expectError(await call("PATCH", `/api/admins/${admin.id}`, as.manager, { role: "manager" }), 403, "ROLE_NOT_ASSIGNABLE");
      await expectError(await call("PATCH", `/api/admins/${manager.id}`, as.owner, { role: "owner" }), 403, "ROLE_NOT_ASSIGNABLE");
    });

    it("ให้สิทธิ์ที่ตัวเองไม่มีไม่ได้", async () => {
      await expectError(await call("PATCH", `/api/admins/${admin.id}`, as.limited, { permissions: ["webhooks:read"] }), 403, "PERMISSIONS_NOT_GRANTABLE");
    });

    it("แก้สิทธิ์แล้ว session ของเป้าหมายถูก revoke และ login ใหม่ได้สิทธิ์ใหม่", async () => {
      const response = await call("PATCH", `/api/admins/${admin.id}`, as.manager, { permissions: ["forward_logs:read", "webhooks:create", "webhooks:read"] });
      const body = await json<AccountBody>(response);

      assert.equal(response.status, 200);
      assert.equal(body.message, "Admin account updated. Active sessions were revoked.");
      assert.deepEqual(body.permissions, ["forward_logs:read", "webhooks:create", "webhooks:read"]);
      assert.equal((await call("GET", "/api/auth/me", as.admin)).status, 401);

      const fresh = await loginHeaders(app, "admin");
      const me = await json<AccountBody>(await call("GET", "/api/auth/me", fresh));
      assert.deepEqual(me.permissions, ["forward_logs:read", "webhooks:create", "webhooks:read"]);
    });

    it("แก้แค่ชื่อไม่ revoke session", async () => {
      const response = await call("PATCH", `/api/admins/${admin.id}`, as.manager, { full_name: "ชื่อใหม่" });
      const body = await json<AccountBody>(response);

      assert.equal(body.full_name, "ชื่อใหม่");
      assert.equal(body.message, "Admin account updated.");
      assert.equal((await call("GET", "/api/auth/me", as.admin)).status, 200);
    });

    it("ปิดบัญชี (inactive) แล้วเป้าหมาย login ไม่ได้", async () => {
      assert.equal((await call("PATCH", `/api/admins/${admin.id}`, as.owner, { status: "inactive" })).status, 200);
      assert.equal((await call("GET", "/api/auth/me", as.admin)).status, 401);
      await expectError(await call("POST", "/api/auth/login", {}, { username: "admin", password: "Passw0rd!" }), 401, "INVALID_CREDENTIALS");
    });

    it("owner ลด role manager เป็น admin ได้", async () => {
      const body = await json<AccountBody>(await call("PATCH", `/api/admins/${manager.id}`, as.owner, { role: "admin" }));
      assert.equal(body.role, "admin");
    });

    it("body ว่างตอบ 400", async () => {
      await expectError(await call("PATCH", `/api/admins/${admin.id}`, as.owner, {}), 400, "VALIDATION_ERROR");
    });
  });

  describe("DELETE /api/admins/:id", () => {
    it("ลบ role ที่ต่ำกว่าได้ (token ของบัญชีนั้นใช้ไม่ได้ทันที) / ลบ role เท่ากัน สูงกว่า หรือตัวเองไม่ได้", async () => {
      await expectError(await call("DELETE", `/api/admins/${owner.id}`, as.manager), 403, "TARGET_ROLE_NOT_MANAGEABLE");
      await expectError(await call("DELETE", `/api/admins/${manager.id}`, as.manager2), 403, "TARGET_ROLE_NOT_MANAGEABLE");
      await expectError(await call("DELETE", `/api/admins/${owner.id}`, as.owner), 403, "CANNOT_MANAGE_OWN_ACCOUNT");

      const response = await call("DELETE", `/api/admins/${admin.id}`, as.manager);
      assert.equal(response.status, 200);
      assert.equal((await call("GET", "/api/auth/me", as.admin)).status, 401);
      assert.equal(authDb.state.permissions.some((row) => row.accountId === admin.id), false);
      await expectError(await call("DELETE", `/api/admins/${admin.id}`, as.manager), 404, "ADMIN_NOT_FOUND");
    });
  });
});
