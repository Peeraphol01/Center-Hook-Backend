// Import Library
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
// Import Helpers
import { createFakeAuthDb, loginHeaders, TEST_AUTH_ENV, TEST_DEVICE_ID, TEST_PASSWORD } from "./helpers/fake-auth-db";

/* -------------------------------------- Setup -------------------------------------- */

// ตั้ง env ก่อนโหลด app (config อ่านค่าตอนโหลด module)
Object.assign(process.env, {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://test:test@localhost:5432/center_hook_test",
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX_REQUESTS: "1000",
  LOGIN_RATE_LIMIT_MAX_REQUESTS: "3",
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
const { clearRateLimitBuckets } = require("../src/middlewares/rate-limit.middleware") as typeof import("../src/middlewares/rate-limit.middleware");

/* -------------------------------------- Test Helpers -------------------------------------- */

type TokenBody = { access_token: string; refresh_token: string; token_type: string; expires_in: number };
type LoginBody = TokenBody & { profile: Record<string, unknown> & { permissions: string[] } };

const json = async <T>(response: Response) => (await response.json()) as T;

// Function เรียก API แบบ JSON
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

const login = (username: string, password = TEST_PASSWORD, deviceId = TEST_DEVICE_ID) => call("POST", "/api/auth/login", { username, password, device_id: deviceId });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/* -------------------------------------- Tests -------------------------------------- */

describe("/api/auth", () => {
  beforeEach(async () => {
    authDb.reset();
    clearRateLimitBuckets();
    await authDb.seedAccount({ username: "owner", role: "owner", permissions: ["forward_logs:read", "admins:read"] });
    await authDb.seedAccount({ username: "closed", role: "admin", status: "inactive" });
  });

  describe("POST /api/auth/login", () => {
    it("login สำเร็จคืน token และ profile พร้อมสิทธิ์ ไม่มี password_hash", async () => {
      const response = await login("owner");
      const body = await json<LoginBody>(response);

      assert.equal(response.status, 200);
      assert.equal(body.token_type, "Bearer");
      assert.equal(body.expires_in, 900);
      assert.ok(body.access_token && body.refresh_token);
      assert.equal(body.profile.username, "owner");
      assert.equal(body.profile.role, "owner");
      assert.deepEqual(body.profile.permissions, ["admins:read", "forward_logs:read"]);
      assert.ok(!("password_hash" in body.profile));
      assert.equal(authDb.state.sessions.filter((session) => session.isActive).length, 1);
    });

    it("รหัสผิด, ไม่มี username และบัญชีถูกปิด ตอบ 401 INVALID_CREDENTIALS เหมือนกัน", async () => {
      for (const [username, password] of [["owner", "wrong-password"], ["nobody", TEST_PASSWORD], ["closed", TEST_PASSWORD]]) {
        clearRateLimitBuckets();
        const response = await login(username, password);
        const body = await json<{ code: string; message: string }>(response);

        assert.equal(response.status, 401, username);
        assert.equal(body.code, "INVALID_CREDENTIALS", username);
        assert.equal(body.message, "Invalid username or password.", username);
      }
    });

    it("body ไม่ครบตอบ 400 VALIDATION_ERROR", async () => {
      const response = await call("POST", "/api/auth/login", { username: "owner" });
      assert.equal(response.status, 400);
      assert.equal((await json<{ code: string }>(response)).code, "VALIDATION_ERROR");
    });

    it("login ใหม่ทำให้ token ของ session เก่าใช้ไม่ได้ (หนึ่งบัญชีหนึ่ง session)", async () => {
      const first = await json<LoginBody>(await login("owner"));
      const second = await json<LoginBody>(await login("owner"));

      assert.equal((await call("GET", "/api/auth/me", undefined, bearer(first.access_token))).status, 401);
      assert.equal((await call("GET", "/api/auth/me", undefined, bearer(second.access_token))).status, 200);
    });

    it("login ซ้ำจากเครื่องเดิม: session เก่าใช้ไม่ได้ตอบ INVALID_TOKEN (ไม่ใช่ SESSION_REPLACED)", async () => {
      const first = await json<LoginBody>(await login("owner"));
      await login("owner");

      const me = await call("GET", "/api/auth/me", undefined, bearer(first.access_token));
      assert.equal(me.status, 401);
      assert.equal((await json<{ code: string }>(me)).code, "INVALID_TOKEN");
    });

    it("device_id ผิดรูปแบบตอบ 400 VALIDATION_ERROR", async () => {
      const response = await login("owner", TEST_PASSWORD, "bad id!");
      assert.equal(response.status, 400);
    });
  });

  describe("1 บัญชีใช้ได้ 1 เครื่อง", () => {
    const OTHER_DEVICE = "test-device-0000000000000002";
    type ConflictBody = { code: string; other_device: { user_agent: string | null; ip_address: string | null; last_active_at: string } };

    it("login จากเครื่องอื่นตอบ 409 ACTIVE_ON_OTHER_DEVICE พร้อมข้อมูลเครื่องเดิม และเครื่องเดิมยังใช้ต่อได้", async () => {
      const first = await json<LoginBody>(await call("POST", "/api/auth/login", { username: "owner", password: TEST_PASSWORD, device_id: TEST_DEVICE_ID }, { "user-agent": "Chrome on Windows" }));
      const response = await login("owner", TEST_PASSWORD, OTHER_DEVICE);
      const body = await json<ConflictBody>(response);

      assert.equal(response.status, 409);
      assert.equal(body.code, "ACTIVE_ON_OTHER_DEVICE");
      assert.equal(body.other_device.user_agent, "Chrome on Windows");
      assert.ok(body.other_device.last_active_at);
      assert.ok(!("access_token" in body));
      assert.equal((await call("GET", "/api/auth/me", undefined, bearer(first.access_token))).status, 200);
    });

    it("ยืนยัน replace_session แล้วเครื่องเดิมถูกเตะออก: access และ refresh ตอบ 401 SESSION_REPLACED", async () => {
      const first = await json<LoginBody>(await login("owner"));
      const second = await call("POST", "/api/auth/login", { username: "owner", password: TEST_PASSWORD, device_id: OTHER_DEVICE, replace_session: true });
      const secondBody = await json<LoginBody>(second);

      assert.equal(second.status, 200);
      const me = await call("GET", "/api/auth/me", undefined, bearer(first.access_token));
      assert.equal(me.status, 401);
      assert.equal((await json<{ code: string }>(me)).code, "SESSION_REPLACED");
      const refreshed = await call("POST", "/api/auth/refresh", { refresh_token: first.refresh_token });
      assert.equal(refreshed.status, 401);
      assert.equal((await json<{ code: string }>(refreshed)).code, "SESSION_REPLACED");
      assert.equal((await call("GET", "/api/auth/me", undefined, bearer(secondBody.access_token))).status, 200);
    });

    it("replace_session รหัสผิดก็ยังตอบ 401 และไม่เตะเครื่องเดิม", async () => {
      const first = await json<LoginBody>(await login("owner"));
      const response = await call("POST", "/api/auth/login", { username: "owner", password: "wrong-password", device_id: OTHER_DEVICE, replace_session: true });

      assert.equal(response.status, 401);
      assert.equal((await call("GET", "/api/auth/me", undefined, bearer(first.access_token))).status, 200);
    });

    it("ไม่ส่ง device_id (เช่นเรียก API ตรง) = ถือเป็นเครื่องใหม่เสมอ", async () => {
      await call("POST", "/api/auth/login", { username: "owner", password: TEST_PASSWORD });
      const response = await call("POST", "/api/auth/login", { username: "owner", password: TEST_PASSWORD });

      assert.equal(response.status, 409);
    });

    it("logout แล้ว login เครื่องอื่นได้เลยไม่ต้องยืนยัน", async () => {
      const first = await json<LoginBody>(await login("owner"));
      await call("POST", "/api/auth/logout", undefined, bearer(first.access_token));

      assert.equal((await login("owner", TEST_PASSWORD, OTHER_DEVICE)).status, 200);
    });

    it("session เดิมหมดอายุแล้ว login เครื่องอื่นได้เลย", async () => {
      await login("owner");
      for (const session of authDb.state.sessions) session.expiresAt = new Date(Date.now() - 1000);

      assert.equal((await login("owner", TEST_PASSWORD, OTHER_DEVICE)).status, 200);
    });
  });

  describe("POST /api/auth/login (rate limit)", () => {
    it("login เกิน LOGIN_RATE_LIMIT_MAX_REQUESTS ต่อ IP ตอบ 429 (รวม path ที่มี / ท้าย)", async () => {
      for (let i = 0; i < 3; i += 1) await login("owner", "wrong-password");

      const limited = await call("POST", "/api/auth/login/", { username: "owner", password: TEST_PASSWORD });
      assert.equal(limited.status, 429);
      assert.equal((await json<{ code: string }>(limited)).code, "RATE_LIMITED");
    });
  });

  describe("ล็อกบัญชีเมื่อใส่รหัสผิดติดกัน (LOGIN_MAX_FAILED_ATTEMPTS = 5)", () => {
    // Function login ผิดหลายครั้ง (ล้าง rate limit ต่อ IP ก่อน เพราะทดสอบการนับต่อบัญชี)
    async function failLogins(times: number): Promise<Response[]> {
      const responses: Response[] = [];
      for (let i = 0; i < times; i += 1) {
        clearRateLimitBuckets();
        responses.push(await login("owner", "wrong-password"));
      }
      return responses;
    }

    const ownerRow = () => authDb.state.accounts.find((account) => account.username === "owner")!;

    it("ผิดครั้งที่ 1-4 ตอบ 401 ครั้งที่ 5 ตอบ 423 ACCOUNT_LOCKED และรหัสถูกก็เข้าไม่ได้จนหมดเวลา", async () => {
      const responses = await failLogins(5);

      assert.deepEqual(responses.slice(0, 4).map((response) => response.status), [401, 401, 401, 401]);

      const locked = await json<{ code: string; locked_until: string; retry_after_seconds: number }>(responses[4]);
      assert.equal(responses[4].status, 423);
      assert.equal(locked.code, "ACCOUNT_LOCKED");
      assert.ok(locked.retry_after_seconds > 14 * 60 && locked.retry_after_seconds <= 15 * 60);

      clearRateLimitBuckets();
      const correct = await login("owner");
      assert.equal(correct.status, 423);
      assert.equal((await json<{ code: string }>(correct)).code, "ACCOUNT_LOCKED");
    });

    it("หมดเวลาล็อกแล้ว login ได้ และตัวนับเริ่มใหม่", async () => {
      await failLogins(5);
      ownerRow().lockedUntil = new Date(Date.now() - 1000);

      clearRateLimitBuckets();
      assert.equal((await login("owner")).status, 200);
      assert.equal(ownerRow().failedLoginCount, 0);
      assert.equal(ownerRow().lockedUntil, null);
    });

    it("login สำเร็จรีเซ็ตตัวนับ (ผิด 4 ถูก 1 ผิด 4 ยังไม่ล็อก)", async () => {
      await failLogins(4);
      clearRateLimitBuckets();
      assert.equal((await login("owner")).status, 200);

      const responses = await failLogins(4);
      assert.ok(responses.every((response) => response.status === 401));
    });

    it("username ที่ไม่มีอยู่จริงไม่ถูกนับหรือล็อก (ตอบ 401 เสมอ)", async () => {
      for (let i = 0; i < 6; i += 1) {
        clearRateLimitBuckets();
        assert.equal((await login("nobody", "wrong-password")).status, 401);
      }
    });
  });

  describe("POST /api/auth/refresh", () => {
    it("ได้ token ชุดใหม่ และ refresh token เดิมใช้ซ้ำไม่ได้", async () => {
      const first = await json<LoginBody>(await login("owner"));
      const refreshed = await call("POST", "/api/auth/refresh", { refresh_token: first.refresh_token });
      const next = await json<TokenBody>(refreshed);

      assert.equal(refreshed.status, 200);
      assert.notEqual(next.refresh_token, first.refresh_token);
      assert.equal((await call("GET", "/api/auth/me", undefined, bearer(next.access_token))).status, 200);

      const reused = await call("POST", "/api/auth/refresh", { refresh_token: first.refresh_token });
      assert.equal(reused.status, 401);
      assert.equal((await json<{ code: string }>(reused)).code, "INVALID_REFRESH_TOKEN");
    });

    it("access token ใช้แทน refresh token ไม่ได้ และ refresh token ใช้แทน access token ไม่ได้", async () => {
      const tokens = await json<LoginBody>(await login("owner"));

      assert.equal((await call("POST", "/api/auth/refresh", { refresh_token: tokens.access_token })).status, 401);
      assert.equal((await call("GET", "/api/auth/me", undefined, bearer(tokens.refresh_token))).status, 401);
    });

    it("หลัง logout refresh token ใช้ไม่ได้", async () => {
      const tokens = await json<LoginBody>(await login("owner"));

      assert.equal((await call("POST", "/api/auth/logout", undefined, bearer(tokens.access_token))).status, 200);
      assert.equal((await call("POST", "/api/auth/refresh", { refresh_token: tokens.refresh_token })).status, 401);
    });
  });

  describe("GET /api/auth/me", () => {
    it("ไม่มี token ตอบ 401 และมี token คืนข้อมูลพร้อมสิทธิ์ล่าสุดจาก DB", async () => {
      assert.equal((await call("GET", "/api/auth/me")).status, 401);

      const headers = await loginHeaders(app, "owner");
      const body = await json<{ username: string; permissions: string[] }>(await call("GET", "/api/auth/me", undefined, headers));

      assert.equal(body.username, "owner");
      assert.deepEqual(body.permissions, ["admins:read", "forward_logs:read"]);
    });

    it("บัญชีถูกปิดระหว่างใช้งาน token เดิมใช้ไม่ได้ทันที", async () => {
      const headers = await loginHeaders(app, "owner");
      authDb.state.accounts.find((account) => account.username === "owner")!.status = "inactive";

      const response = await call("GET", "/api/auth/me", undefined, headers);
      assert.equal(response.status, 401);
      assert.equal((await json<{ code: string }>(response)).code, "INVALID_TOKEN");
    });
  });

  describe("PATCH /api/auth/me/password", () => {
    it("รหัสปัจจุบันผิดตอบ 400 INVALID_CURRENT_PASSWORD", async () => {
      const headers = await loginHeaders(app, "owner");
      const response = await call("PATCH", "/api/auth/me/password", { current_password: "wrong-password", new_password: "NewPassw0rd!" }, headers);

      assert.equal(response.status, 400);
      assert.equal((await json<{ code: string }>(response)).code, "INVALID_CURRENT_PASSWORD");
    });

    it("รหัสใหม่สั้นเกินหรือซ้ำรหัสเดิมตอบ 400 VALIDATION_ERROR", async () => {
      const headers = await loginHeaders(app, "owner");

      for (const newPassword of ["short", TEST_PASSWORD]) {
        const response = await call("PATCH", "/api/auth/me/password", { current_password: TEST_PASSWORD, new_password: newPassword }, headers);
        assert.equal(response.status, 400, newPassword);
        assert.equal((await json<{ code: string }>(response)).code, "VALIDATION_ERROR", newPassword);
      }
    });

    it("เปลี่ยนแล้ว login ด้วยรหัสใหม่ได้ รหัสเก่าใช้ไม่ได้ และ session ปัจจุบันใช้ต่อได้", async () => {
      const headers = await loginHeaders(app, "owner");
      const response = await call("PATCH", "/api/auth/me/password", { current_password: TEST_PASSWORD, new_password: "NewPassw0rd!" }, headers);

      assert.equal(response.status, 200);
      assert.equal((await call("GET", "/api/auth/me", undefined, headers)).status, 200);

      clearRateLimitBuckets();
      assert.equal((await login("owner")).status, 401);
      assert.equal((await login("owner", "NewPassw0rd!")).status, 200);
    });
  });
});
