// Import Library
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
// Import Helpers
import { createFakeAuthDb, loginHeaders, TEST_AUTH_ENV, TEST_DEVICE_ID, TEST_PASSWORD, type FakeAuditLog } from "./helpers/fake-auth-db";

/* -------------------------------------- Setup -------------------------------------- */

// ตั้ง env ก่อนโหลด app (config อ่านค่าตอนโหลด module)
Object.assign(process.env, {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://test:test@localhost:5432/center_hook_test",
  LINE_CHANNEL_SECRET: "test-line-channel-secret",
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX_REQUESTS: "1000",
  LOGIN_RATE_LIMIT_MAX_REQUESTS: "1000",
  ...TEST_AUTH_ENV,
});

// Config env ที่แต่ละ test เปลี่ยนได้ (คืนค่าเดิมใน afterEach)
const MUTABLE_ENV = [
  "TRUST_PROXY_HOPS", "PROXY_SHARED_SECRET", "IP_ALLOWLIST_ADMIN", "IP_ALLOWLIST_LINE_PUSH", "SECURITY_BRUTE_FORCE_THRESHOLD",
  "SECURITY_ALERT_LINE_TO", "LINE_CHANNEL_ACCESS_TOKEN", "LOGIN_MAX_FAILED_ATTEMPTS", "AUDIT_LOG_RETENTION_DAYS",
] as const;

const authDb = createFakeAuthDb();

class FakePrismaClient {
  account = authDb.delegates.account;
  accountPermission = authDb.delegates.accountPermission;
  userSession = authDb.delegates.userSession;
  auditLog = authDb.delegates.auditLog;
  $queryRaw = authDb.delegates.$queryRaw;
  $transaction = async <T>(work: (tx: this) => Promise<T>) => work(this);
  webhook = { findMany: async () => [] };
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

const { default: app } = require("../src/app") as typeof import("../src/app");
const { clearRateLimitBuckets } = require("../src/middlewares/rate-limit.middleware") as typeof import("../src/middlewares/rate-limit.middleware");
const { waitForBackgroundTasks } = require("../src/utils/background-tasks") as typeof import("../src/utils/background-tasks");
const { resetSecurityAlertState } = require("../src/services/security-alert.service") as typeof import("../src/services/security-alert.service");
const { deleteExpiredAuditLogs, resetAuditThrottle } = require("../src/services/audit.service") as typeof import("../src/services/audit.service");
const { pickForwardedIp, parseCidrList, normalizeIp } = require("../src/utils/ip") as typeof import("../src/utils/ip");
const { validateSecurityConfig } = require("../src/config/security.config") as typeof import("../src/config/security.config");

/* -------------------------------------- Test Helpers -------------------------------------- */

const json = async <T>(response: Response) => (await response.json()) as T;

// Function เรียก API แบบ JSON พร้อม IP ของ client (ผ่าน X-Forwarded-For)
function call(method: string, path: string, options: { body?: unknown; headers?: Record<string, string>; ip?: string } = {}): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: {
      "user-agent": "audit-test-agent",
      ...(options.ip && { "x-forwarded-for": options.ip }),
      ...options.headers,
      ...(options.body !== undefined && { "content-type": "application/json" }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  }));
}

const login = (username: string, ip = "203.0.113.10", password = TEST_PASSWORD) =>
  call("POST", "/api/auth/login", { body: { username, password, device_id: TEST_DEVICE_ID }, ip });

// Function รอให้ audit log เขียนเสร็จ แล้วคืนแถวทั้งหมด (เก่าไปใหม่)
async function auditRows(): Promise<FakeAuditLog[]> {
  await waitForBackgroundTasks(2000);
  return authDb.state.auditLogs;
}

// Function แปลงแถวเป็น JSON (id เป็น BigInt)
const stringify = (value: unknown) => JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

const actions = async () => (await auditRows()).map((row) => row.action);

type ListBody = { data: Record<string, unknown>[]; pagination: { total: number; total_pages: number } };

/* -------------------------------------- Tests -------------------------------------- */

describe("audit log", () => {
  const savedEnv: Record<string, string | undefined> = {};
  let AUDITOR: Record<string, string> = {};

  beforeEach(async () => {
    for (const name of MUTABLE_ENV) savedEnv[name] = process.env[name];
    authDb.reset();
    clearRateLimitBuckets();
    resetSecurityAlertState();
    resetAuditThrottle();
    await authDb.seedAccount({ username: "owner", role: "owner", permissions: ["audit_logs:read", "admins:read", "admins:update"] });
    await authDb.seedAccount({ username: "staff", role: "admin", permissions: ["forward_logs:read"] });
    AUDITOR = await loginHeaders(app, "owner");
    await waitForBackgroundTasks(2000);
    authDb.state.auditLogs = [];
  });

  afterEach(() => {
    for (const name of MUTABLE_ENV) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    mock.restoreAll();
  });

  describe("บันทึกเหตุการณ์ login", () => {
    it("login สำเร็จเก็บผู้ใช้, session, IP, user agent และ request id", async () => {
      const response = await call("POST", "/api/auth/login", {
        body: { username: "staff", password: TEST_PASSWORD },
        ip: "198.51.100.7",
        headers: { "x-request-id": "req-login-1" },
      });
      assert.equal(response.status, 200);

      const [row] = await auditRows();
      assert.equal(row.action, "auth.login.success");
      assert.equal(row.result, "success");
      assert.equal(row.severity, "info");
      assert.equal(row.actorUsername, "staff");
      assert.equal(typeof row.actorAccountId, "number");
      assert.equal(typeof row.sessionId, "number");
      assert.equal(row.ipAddress, "198.51.100.7");
      assert.equal(row.userAgent, "audit-test-agent");
      assert.equal(row.requestId, "req-login-1");
      assert.equal(row.method, "POST");
      assert.equal(row.path, "/api/auth/login");
    });

    it("login ผิดเก็บ username ที่พิมพ์มาแม้ไม่มีบัญชีจริง และไม่เก็บรหัสผ่าน", async () => {
      assert.equal((await login("ghost", "198.51.100.8", "secret-guess")).status, 401);
      assert.equal((await login("staff", "198.51.100.8", "wrong-password")).status, 401);

      const rows = await auditRows();
      assert.deepEqual(rows.map((row) => [row.action, row.actorUsername, (row.metadata as { reason: string }).reason]), [
        ["auth.login.failed", "ghost", "unknown_username"],
        ["auth.login.failed", "staff", "invalid_password"],
      ]);
      assert.ok(rows.every((row) => row.severity === "warning" && row.ipAddress === "198.51.100.8"));
      assert.doesNotMatch(stringify(rows), /secret-guess|wrong-password/);
    });

    it("login จาก IP ที่บัญชีไม่เคยใช้บันทึก auth.login.new_ip (login ครั้งแรกและ IP เดิมไม่นับ)", async () => {
      await login("staff", "198.51.100.1");
      await login("staff", "198.51.100.1");
      assert.deepEqual(await actions(), ["auth.login.success", "auth.login.success"]);

      authDb.state.auditLogs = [];
      await login("staff", "192.0.2.99");
      assert.deepEqual(await actions(), ["auth.login.success", "auth.login.new_ip"]);
    });

    it("ล็อกบัญชีบันทึก auth.account.locked (critical) และพยายาม login ระหว่างล็อกบันทึก auth.login.blocked", async () => {
      process.env.LOGIN_MAX_FAILED_ATTEMPTS = "2";
      await login("staff", "198.51.100.9", "bad-1");
      assert.equal((await login("staff", "198.51.100.9", "bad-2")).status, 423);
      assert.equal((await login("staff", "198.51.100.9")).status, 423);

      const rows = await auditRows();
      const locked = rows.find((row) => row.action === "auth.account.locked");
      assert.equal(locked?.severity, "critical");
      assert.equal(locked?.targetType, "account");
      assert.equal(rows.at(-1)?.action, "auth.login.blocked");
    });
  });

  describe("refresh token", () => {
    it("ใช้ refresh token ที่หมุนไปแล้วซ้ำ = reuse_detected (critical) และ revoke session ทันที", async () => {
      const first = await json<{ refresh_token: string }>(await login("staff"));
      const rotated = await call("POST", "/api/auth/refresh", { body: { refresh_token: first.refresh_token } });
      const second = await json<{ refresh_token: string; access_token: string }>(rotated);
      assert.equal(rotated.status, 200);

      const reused = await call("POST", "/api/auth/refresh", { body: { refresh_token: first.refresh_token } });
      assert.equal(reused.status, 401);

      // token ชุดใหม่ก็ใช้ไม่ได้แล้ว เพราะ session ถูก revoke
      assert.equal((await call("POST", "/api/auth/refresh", { body: { refresh_token: second.refresh_token } })).status, 401);
      assert.equal((await call("GET", "/api/auth/me", { headers: { authorization: `Bearer ${second.access_token}` } })).status, 401);

      const rows = await auditRows();
      const reuse = rows.find((row) => row.action === "auth.refresh.reuse_detected");
      assert.equal(reuse?.severity, "critical");
      assert.equal(reuse?.actorUsername, "staff");
      assert.deepEqual(rows.map((row) => row.action), [
        "auth.login.success", "auth.refresh.success", "auth.refresh.reuse_detected", "auth.refresh.failed",
      ]);
    });
  });

  describe("การจัดการบัญชีและการถูกปฏิเสธ", () => {
    it("แก้ role บันทึก admin.update พร้อมค่าก่อน/หลัง (severity warning)", async () => {
      const staff = authDb.state.accounts.find((row) => row.username === "staff")!;
      const response = await call("PATCH", `/api/admins/${staff.id}`, { body: { role: "manager" }, headers: AUDITOR, ip: "198.51.100.20" });
      assert.equal(response.status, 200);

      const row = (await auditRows()).find((item) => item.action === "admin.update")!;
      const metadata = row.metadata as { before: { role: string }; after: { role: string }; revoked_sessions: number };
      assert.equal(row.actorUsername, "owner");
      assert.equal(row.targetId, String(staff.id));
      assert.equal(row.severity, "warning");
      assert.equal(metadata.before.role, "admin");
      assert.equal(metadata.after.role, "manager");
      assert.doesNotMatch(stringify(row), /password/i);
    });

    it("ไม่มีสิทธิ์ (403) บันทึก access.denied พร้อมสิทธิ์ที่ขาด", async () => {
      const staffHeaders = await loginHeaders(app, "staff");
      await waitForBackgroundTasks(2000);
      authDb.state.auditLogs = [];

      assert.equal((await call("GET", "/api/audit-logs", { headers: staffHeaders, ip: "198.51.100.30" })).status, 403);

      const [row] = await auditRows();
      assert.equal(row.action, "access.denied");
      assert.equal(row.actorUsername, "staff");
      assert.equal(row.path, "/api/audit-logs");
      assert.deepEqual((row.metadata as { required_permissions: string[] }).required_permissions, ["audit_logs:read"]);
    });

    it("LINE signature ผิดบันทึก line.webhook.invalid_signature (ไม่บันทึกซ้ำถี่ๆ)", async () => {
      for (let i = 0; i < 3; i += 1) {
        const response = await call("POST", "/api/line/webhook", { body: { events: [] }, headers: { "x-line-signature": "bad" } });
        assert.equal(response.status, 401);
      }

      assert.deepEqual(await actions(), ["line.webhook.invalid_signature"]);
    });
  });

  describe("GET /api/audit-logs", () => {
    it("ต้องมีสิทธิ์ audit_logs:read", async () => {
      assert.equal((await call("GET", "/api/audit-logs")).status, 401);
      assert.equal((await call("GET", "/api/audit-logs", { headers: AUDITOR })).status, 200);
    });

    it("ค้นหาตาม action_prefix, ip_address, actor_username, severity และดูรายการเดียวได้", async () => {
      await login("ghost", "192.0.2.1", "x");
      await login("staff", "192.0.2.2");
      await auditRows();

      const list = async (query: string) => json<ListBody>(await call("GET", `/api/audit-logs?${query}`, { headers: AUDITOR }));

      const failed = await list("action=auth.login.failed");
      assert.equal(failed.pagination.total, 1);
      assert.equal(failed.data[0].actor_username, "ghost");
      assert.equal((await list("ip_address=192.0.2.2")).data[0].action, "auth.login.success");
      assert.equal((await list("action_prefix=auth.")).pagination.total, 2);
      assert.equal((await list("actor_username=staff")).pagination.total, 1);
      assert.equal((await list("severity=warning")).data[0].action, "auth.login.failed");

      const detail = await call("GET", `/api/audit-logs/${failed.data[0].id}`, { headers: AUDITOR });
      assert.equal(detail.status, 200);
      assert.equal((await json<{ id: string }>(detail)).id, failed.data[0].id);
    });

    it("ไม่พบตอบ 404, id ผิดรูปหรือ query ผิดตอบ 400", async () => {
      assert.equal((await call("GET", "/api/audit-logs/999", { headers: AUDITOR })).status, 404);
      assert.equal((await call("GET", "/api/audit-logs/abc", { headers: AUDITOR })).status, 400);
      assert.equal((await call("GET", "/api/audit-logs?severity=bad", { headers: AUDITOR })).status, 400);
      assert.equal((await call("GET", "/api/audit-logs?limit=1000", { headers: AUDITOR })).status, 400);
    });

    it("ไม่มี API แก้หรือลบ audit log", async () => {
      assert.equal((await call("DELETE", "/api/audit-logs/1", { headers: AUDITOR })).status, 404);
      assert.equal((await call("PATCH", "/api/audit-logs/1", { headers: AUDITOR, body: {} })).status, 404);
    });
  });

  describe("GET /api/audit-logs/security-summary", () => {
    it("สรุป IP / username ที่ login ผิดบ่อยและเหตุการณ์ warning/critical ล่าสุด", async () => {
      for (let i = 0; i < 3; i += 1) await login(`guess${i}`, "192.0.2.50", "x");
      await login("ghost", "192.0.2.51", "x");
      await login("staff", "192.0.2.52");
      await auditRows();

      const body = await json<{
        counts_by_action: { action: string; count: number }[];
        top_failed_login_ips: { ip_address: string; count: number }[];
        top_failed_login_usernames: { username: string; count: number }[];
        recent_alerts: { action: string }[];
      }>(await call("GET", "/api/audit-logs/security-summary?hours=1", { headers: AUDITOR }));

      assert.deepEqual(body.top_failed_login_ips[0], { ip_address: "192.0.2.50", count: 3 });
      assert.equal(body.top_failed_login_ips.length, 2);
      assert.equal(body.top_failed_login_usernames.length, 4);
      assert.deepEqual(body.counts_by_action.find((item) => item.action === "auth.login.failed"), { action: "auth.login.failed", count: 4 });
      assert.ok(body.recent_alerts.every((item) => item.action !== "auth.login.success"));
    });
  });

  describe("ตรวจจับ brute force และแจ้งเตือน", () => {
    it("login ผิดจาก IP เดียวครบเกณฑ์ บันทึก security.brute_force_suspected ครั้งเดียว และส่งแจ้งเตือนเข้า LINE", async () => {
      process.env.SECURITY_BRUTE_FORCE_THRESHOLD = "3";
      process.env.SECURITY_ALERT_LINE_TO = "Cadmin-group";
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
      const sent: { url: string; body: { to: string; messages: { text: string }[] } }[] = [];
      mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      });

      for (let i = 0; i < 5; i += 1) await login(`user${i}`, "192.0.2.77", "x");

      const rows = await auditRows();
      const suspected = rows.filter((row) => row.action === "security.brute_force_suspected");
      assert.equal(suspected.length, 1);
      assert.equal(suspected[0].severity, "critical");
      assert.equal(suspected[0].ipAddress, "192.0.2.77");
      assert.equal(sent.length, 1);
      assert.equal(sent[0].url, "https://api.line.me/v2/bot/message/push");
      assert.equal(sent[0].body.to, "Cadmin-group");
      assert.match(sent[0].body.messages[0].text, /security\.brute_force_suspected[\s\S]*192\.0\.2\.77/);
    });

    it("login เครื่องอื่น: ติด 409 บันทึก auth.login.device_conflict, ยืนยันเตะแล้วบันทึก auth.session.replaced (critical) และแจ้งเตือนเข้า LINE", async () => {
      process.env.SECURITY_ALERT_LINE_TO = "Cadmin-group";
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
      const sent: string[] = [];
      mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
        sent.push((JSON.parse(String(init.body)) as { messages: { text: string }[] }).messages[0].text);
        return new Response("{}", { status: 200 });
      });
      const otherDevice = (replace: boolean) =>
        call("POST", "/api/auth/login", { ip: "198.51.100.9", body: { username: "staff", password: TEST_PASSWORD, device_id: "test-device-0000000000000009", replace_session: replace } });

      await login("staff", "203.0.113.10");
      assert.equal((await otherDevice(false)).status, 409);
      assert.equal((await otherDevice(true)).status, 200);

      const rows = await auditRows();
      const conflict = rows.find((row) => row.action === "auth.login.device_conflict");
      const replaced = rows.find((row) => row.action === "auth.session.replaced");
      assert.equal(conflict?.severity, "warning");
      assert.equal(replaced?.severity, "critical");
      assert.equal(replaced?.ipAddress, "198.51.100.9");
      assert.match(stringify(replaced?.metadata), /"replaced_ip_address":"203\.0\.113\.10"/);
      assert.equal(sent.length, 1);
      assert.match(sent[0], /auth\.session\.replaced[\s\S]*staff[\s\S]*198\.51\.100\.9/);
    });

    it("ไม่ตั้ง SECURITY_ALERT_LINE_TO = ไม่ส่งแจ้งเตือน", async () => {
      process.env.SECURITY_BRUTE_FORCE_THRESHOLD = "1";
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
      delete process.env.SECURITY_ALERT_LINE_TO;
      const fetchMock = mock.method(globalThis, "fetch", async () => new Response("{}"));

      await login("ghost", "192.0.2.78", "x");
      await auditRows();

      assert.equal(fetchMock.mock.callCount(), 0);
    });
  });

  describe("IP allowlist", () => {
    it("ตั้ง IP_ALLOWLIST_ADMIN แล้ว IP นอกวงตอบ 403 IP_NOT_ALLOWED และบันทึก security.ip_blocked", async () => {
      process.env.IP_ALLOWLIST_ADMIN = "10.0.0.0/8, 192.168.1.10";

      const blocked = await login("staff", "8.8.8.8");
      assert.equal(blocked.status, 403);
      assert.equal((await json<{ code: string }>(blocked)).code, "IP_NOT_ALLOWED");
      assert.equal((await login("staff", "10.20.30.40")).status, 200);
      assert.equal((await login("staff", "192.168.1.10")).status, 200);
      assert.equal((await call("GET", "/api/audit-logs", { headers: AUDITOR, ip: "8.8.4.4" })).status, 403);

      const rows = await auditRows();
      const ipBlocked = rows.filter((row) => row.action === "security.ip_blocked");
      assert.deepEqual(ipBlocked.map((row) => row.ipAddress), ["8.8.8.8", "8.8.4.4"]);
    });

    it("ไม่กระทบ /api/line/webhook (LINE ไม่มี IP ตายตัว) และ health check", async () => {
      process.env.IP_ALLOWLIST_ADMIN = "10.0.0.0/8";

      const webhook = await call("POST", "/api/line/webhook", { body: { events: [] }, ip: "8.8.8.8", headers: { "x-line-signature": "bad" } });
      assert.equal((await json<{ code: string }>(webhook)).code, "INVALID_LINE_SIGNATURE");
      assert.notEqual((await call("GET", "/", { ip: "8.8.8.8" })).status, 403);
    });

    it("IP_ALLOWLIST_LINE_PUSH จำกัดเฉพาะ /api/line/push และรองรับ IPv6", async () => {
      process.env.IP_ALLOWLIST_LINE_PUSH = "2001:db8::/32";
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
      const push = (ip: string) => call("POST", "/api/line/push", { ip, headers: { authorization: "Bearer test-line-token" }, body: {} });

      assert.equal((await push("203.0.113.5")).status, 403);
      assert.notEqual((await push("2001:db8:1::5")).status, 403);
      assert.equal((await login("staff", "203.0.113.5")).status, 200);
    });

    it("TRUST_PROXY_HOPS=0 ไม่เชื่อ X-Forwarded-For (ปลอม IP ด้วย header ไม่ได้)", async () => {
      process.env.IP_ALLOWLIST_ADMIN = "10.0.0.0/8";
      process.env.TRUST_PROXY_HOPS = "0";

      assert.equal((await login("staff", "10.0.0.1")).status, 403);
    });
  });

  describe("PROXY_SHARED_SECRET (IP ผู้ใช้จาก frontend)", () => {
    const SECRET = "test-proxy-shared-secret-0123456789abcdef";
    const loginVia = (headers: Record<string, string>, ip = "198.51.100.1") =>
      call("POST", "/api/auth/login", { body: { username: "staff", password: TEST_PASSWORD }, ip, headers });
    const lastIp = async () => (await auditRows()).at(-1)?.ipAddress;

    beforeEach(() => {
      process.env.PROXY_SHARED_SECRET = SECRET;
    });

    it("secret ถูก = ใช้ x-client-ip", async () => {
      await loginVia({ "x-proxy-secret": SECRET, "x-client-ip": "203.0.113.77" });

      assert.equal(await lastIp(), "203.0.113.77");
    });

    it("secret ผิด / ไม่มี secret = ไม่เชื่อ x-client-ip ใช้ X-Forwarded-For", async () => {
      await loginVia({ "x-proxy-secret": "wrong-secret", "x-client-ip": "203.0.113.77" });
      assert.equal(await lastIp(), "198.51.100.1");

      await loginVia({ "x-client-ip": "203.0.113.78" }, "198.51.100.2");
      assert.equal(await lastIp(), "198.51.100.2");
    });

    it("ไม่ตั้ง PROXY_SHARED_SECRET = ไม่เชื่อ x-client-ip แม้ส่ง header มา", async () => {
      delete process.env.PROXY_SHARED_SECRET;
      await loginVia({ "x-proxy-secret": SECRET, "x-client-ip": "203.0.113.77" });

      assert.equal(await lastIp(), "198.51.100.1");
    });

    it("x-client-ip ผิดรูปใช้ X-Forwarded-For แทน", async () => {
      await loginVia({ "x-proxy-secret": SECRET, "x-client-ip": "<script>" });

      assert.equal(await lastIp(), "198.51.100.1");
    });

    it("IP allowlist ใช้ IP จาก x-client-ip เมื่อ secret ถูก", async () => {
      process.env.IP_ALLOWLIST_ADMIN = "10.0.0.0/8";

      assert.equal((await loginVia({ "x-proxy-secret": SECRET, "x-client-ip": "10.1.2.3" })).status, 200);
      assert.equal((await loginVia({ "x-proxy-secret": "wrong", "x-client-ip": "10.1.2.3" })).status, 403);
    });

    it("secret สั้นกว่า 32 ตัว = ตั้งค่าผิด", () => {
      process.env.PROXY_SHARED_SECRET = "short";

      assert.throws(() => validateSecurityConfig(), /PROXY_SHARED_SECRET/);
    });
  });

  describe("อายุของ audit log", () => {
    it("ลบเฉพาะแถวที่เก่ากว่า AUDIT_LOG_RETENTION_DAYS", async () => {
      process.env.AUDIT_LOG_RETENTION_DAYS = "30";
      await login("ghost", "192.0.2.1", "x");
      await login("ghost", "192.0.2.1", "x");
      const rows = await auditRows();
      rows[0].occurredAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);

      assert.equal(await deleteExpiredAuditLogs(), 1);
      assert.equal(authDb.state.auditLogs.length, 1);
    });
  });
});

describe("ip utils", () => {
  it("pickForwardedIp เชื่อเฉพาะจำนวน proxy ที่ตั้งไว้ (นับจากขวา)", () => {
    assert.equal(pickForwardedIp("1.1.1.1, 2.2.2.2, 3.3.3.3", 1), "3.3.3.3");
    assert.equal(pickForwardedIp("1.1.1.1, 2.2.2.2, 3.3.3.3", 2), "2.2.2.2");
    assert.equal(pickForwardedIp("1.1.1.1", 3), "1.1.1.1");
    assert.equal(pickForwardedIp("1.1.1.1", 0), null);
    assert.equal(pickForwardedIp("not-an-ip", 1), null);
    assert.equal(pickForwardedIp(undefined, 1), null);
  });

  it("normalizeIp ตัด ::ffff: และ zone id", () => {
    assert.equal(normalizeIp("::ffff:10.0.0.1"), "10.0.0.1");
    assert.equal(normalizeIp("fe80::1%eth0"), "fe80::1");
    assert.equal(normalizeIp("[2001:DB8::1]"), "2001:db8::1");
    assert.equal(normalizeIp("<script>"), null);
  });

  it("parseCidrList ตรวจ IPv4/IPv6 และโยน error เมื่อค่าผิดรูป", () => {
    const matcher = parseCidrList("10.0.0.0/8, 2001:db8::/32, 203.0.113.7", "TEST");

    assert.ok(matcher.matches("10.255.0.1"));
    assert.ok(matcher.matches("::ffff:10.1.1.1"));
    assert.ok(matcher.matches("2001:db8:ffff::1"));
    assert.ok(matcher.matches("203.0.113.7"));
    assert.ok(!matcher.matches("203.0.113.8"));
    assert.ok(!matcher.matches(null));
    assert.throws(() => parseCidrList("10.0.0.0/33", "TEST"), /TEST contains an invalid IP or CIDR/);
    assert.throws(() => parseCidrList("example.com", "TEST"), /invalid/);
  });
});
