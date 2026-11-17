// Import Library
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
// Import Helpers
import { createFakeAuthDb, loginHeaders, TEST_AUTH_ENV } from "./helpers/fake-auth-db";

/* -------------------------------------- Setup -------------------------------------- */

// ตั้ง env ก่อนโหลด app (config อ่านค่าตอนโหลด module)
Object.assign(process.env, {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://test:test@localhost:5432/center_hook_test",
  LINE_CHANNEL_SECRET: "test-line-channel-secret",
  FORWARD_TIMEOUT_MS: "1000",
  FORWARD_MAX_ATTEMPTS: "3",
  FORWARD_RETRY_DELAY_MS: "1",
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX_REQUESTS: "3",
  ...TEST_AUTH_ENV,
});

// Config ฐานข้อมูลปลอมของบัญชี/สิทธิ์/session (ใช้ login จริงผ่าน /api/auth/login)
const authDb = createFakeAuthDb();

// Type แถวของ forward_logs ในฐานข้อมูลปลอม (ชื่อ field แบบ Prisma)
type FakeRow = Record<string, unknown> & { id: number; createdAt: Date };

// Config ฐานข้อมูลปลอม: ให้ repository ค้นหา/นับ/ลบจาก memory
const fakeDb = {
  rows: [] as FakeRow[],
  nextId: 1,
  // ตั้งเป็น Error เพื่อให้การค้นหาครั้งถัดไปล้มครั้งเดียว
  failNext: null as Error | null,
  reset(): void {
    this.rows = [];
    this.nextId = 1;
    this.failNext = null;
  },
};

// Function ตรวจว่าแถวตรงเงื่อนไข where ที่ repository ส่งมา (เท่ากันทุก field, createdAt รองรับ gte/lte/lt)
function matches(row: FakeRow, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (condition && typeof condition === "object" && !(condition instanceof Date)) {
      const { gte, lte, lt } = condition as { gte?: Date; lte?: Date; lt?: Date };
      const value = row[key] as Date;
      return (!gte || value >= gte) && (!lte || value <= lte) && (!lt || value < lt);
    }
    return row[key] === condition;
  });
}

class FakePrismaClient {
  account = authDb.delegates.account;
  accountPermission = authDb.delegates.accountPermission;
  userSession = authDb.delegates.userSession;
  $queryRaw = authDb.delegates.$queryRaw;
  $transaction = async <T>(work: (tx: this) => Promise<T>) => work(this);

  forwardLog = {
    findMany: async ({ where, skip = 0, take, omit = {} }: { where?: Record<string, unknown>; skip?: number; take?: number; omit?: Record<string, boolean> }) => {
      if (fakeDb.failNext) {
        const error = fakeDb.failNext;
        fakeDb.failNext = null;
        throw error;
      }
      return fakeDb.rows
        .filter((row) => matches(row, where))
        .sort((a, b) => b.id - a.id)
        .slice(skip, take === undefined ? undefined : skip + take)
        .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !omit[key])));
    },
    count: async ({ where }: { where?: Record<string, unknown> }) => fakeDb.rows.filter((row) => matches(row, where)).length,
    findUnique: async ({ where }: { where: { id: number } }) => fakeDb.rows.find((row) => row.id === where.id) ?? null,
    deleteMany: async ({ where }: { where?: Record<string, unknown> }) => {
      const before = fakeDb.rows.length;
      fakeDb.rows = fakeDb.rows.filter((row) => !matches(row, where));
      return { count: before - fakeDb.rows.length };
    },
  };
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

// Function เพิ่ม forward log ลงฐานข้อมูลปลอมโดยตรง (เตรียมข้อมูลให้ API ค้นหา)
function seedForwardLog(overrides: Partial<FakeRow> = {}): FakeRow {
  const row = {
    direction: "INBOUND", requestId: "req-1", webhookEventId: null, project: "default", targetUrl: "http://other.test/webhook",
    lineUserId: "U1", eventType: "message", messageType: "text", content: "hello", payload: { type: "message" }, status: "SUCCESS",
    httpStatus: 200, responseBody: "{}", errorMessage: null, attempts: 1, durationMs: 5, forwardedAt: new Date(),
    ...overrides,
    id: fakeDb.nextId++,
    createdAt: overrides.createdAt ?? new Date(),
  } as FakeRow;
  fakeDb.rows.push(row);
  return row;
}

const { default: app } = require("../src/app") as typeof import("../src/app");
const { clearRateLimitBuckets } = require("../src/middlewares/rate-limit.middleware") as typeof import("../src/middlewares/rate-limit.middleware");
const { deleteExpiredForwardLogs } = require("../src/services/log.service") as typeof import("../src/services/log.service");

/* -------------------------------------- Test Helpers -------------------------------------- */

// Config header ของบัญชีที่มีสิทธิ์ forward_logs:read (login ใหม่ทุก test ใน beforeEach)
let AUTH: Record<string, string> = {};
const DAY_MS = 24 * 60 * 60 * 1000;

// Function เรียก API log ด้วย access token ที่ถูกต้อง (ล้างตัวนับ rate limit ก่อน เพดานใน test-env คือ 3)
async function get(path: string, headers: Record<string, string> = AUTH): Promise<Response> {
  clearRateLimitBuckets();
  return app.request(path, { headers });
}

const json = async <T>(response: Response) => (await response.json()) as T;

type ListBody = { data: Record<string, unknown>[]; pagination: { page: number; limit: number; total: number; total_pages: number } };

/* -------------------------------------- Tests -------------------------------------- */

describe("/api/forward-logs", () => {
  beforeEach(async () => {
    fakeDb.reset();
    authDb.reset();
    await authDb.seedAccount({ username: "viewer", role: "admin", permissions: ["forward_logs:read"] });
    await authDb.seedAccount({ username: "nolog", role: "admin", permissions: ["webhooks:read"] });
    AUTH = await loginHeaders(app, "viewer");
    clearRateLimitBuckets();
  });

  afterEach(() => {
    clearRateLimitBuckets();
  });

  describe("สิทธิ์การเข้าถึง (JWT + forward_logs:read)", () => {
    it("ไม่ส่ง token หรือ token ผิดตอบ 401 INVALID_TOKEN", async () => {
      const missing = await get("/api/forward-logs", {});

      assert.equal(missing.status, 401);
      assert.equal((await json<{ code: string }>(missing)).code, "INVALID_TOKEN");
      assert.equal((await get("/api/forward-logs", { authorization: "Bearer not-a-jwt" })).status, 401);
      assert.equal((await get("/api/forward-logs/1", { authorization: `Basic ${Buffer.from("a:b").toString("base64")}` })).status, 401);
    });

    it("มีสิทธิ์ forward_logs:read เข้าได้", async () => {
      assert.equal((await get("/api/forward-logs")).status, 200);
    });

    it("ไม่มีสิทธิ์ forward_logs:read ตอบ 403 FORBIDDEN พร้อมสิทธิ์ที่ขาด", async () => {
      const response = await get("/api/forward-logs", await loginHeaders(app, "nolog"));
      const body = await json<{ code: string; required_permissions: string[] }>(response);

      assert.equal(response.status, 403);
      assert.equal(body.code, "FORBIDDEN");
      assert.deepEqual(body.required_permissions, ["forward_logs:read"]);
    });

    it("logout แล้ว token เดิมใช้ไม่ได้ทันที", async () => {
      clearRateLimitBuckets();
      assert.equal((await app.request("/api/auth/logout", { method: "POST", headers: AUTH })).status, 200);
      assert.equal((await get("/api/forward-logs")).status, 401);
    });
  });

  describe("GET /api/forward-logs", () => {
    it("เรียงจากใหม่ไปเก่า แบ่งหน้า และไม่ส่ง payload/response_body", async () => {
      for (let i = 1; i <= 5; i += 1) seedForwardLog({ content: `m${i}` });

      const body = await json<ListBody>(await get("/api/forward-logs?page=2&limit=2"));

      assert.deepEqual(body.data.map((item) => item.content), ["m3", "m2"]);
      assert.deepEqual(body.pagination, { page: 2, limit: 2, total: 5, total_pages: 3 });
      assert.ok(!("payload" in body.data[0]) && !("response_body" in body.data[0]));
      assert.deepEqual(Object.keys(body.data[0]).sort(), [
        "attempts", "content", "created_at", "direction", "duration_ms", "error_message", "event_type", "forwarded_at", "http_status",
        "id", "line_user_id", "message_type", "project", "request_id", "status", "target_url", "webhook_event_id",
      ]);
    });

    it("กรองตาม direction, status, project, line_user_id, event_type และช่วงเวลา", async () => {
      const now = Date.now();
      seedForwardLog({ content: "a", direction: "INBOUND", status: "SUCCESS", project: "newlabor", lineUserId: "U1", eventType: "postback", createdAt: new Date(now - 3 * DAY_MS) });
      seedForwardLog({ content: "b", direction: "OUTBOUND", status: "FAILED", project: "newlabor", lineUserId: "U2", eventType: "push", createdAt: new Date(now - DAY_MS) });
      seedForwardLog({ content: "c", direction: "INBOUND", status: "SKIPPED", project: "default", lineUserId: "U1", eventType: "message", createdAt: new Date(now) });

      const contents = async (query: string) => (await json<ListBody>(await get(`/api/forward-logs?${query}`))).data.map((item) => item.content);
      const iso = (offsetDays: number) => new Date(now + offsetDays * DAY_MS).toISOString();

      assert.deepEqual(await contents("direction=OUTBOUND"), ["b"]);
      assert.deepEqual(await contents("status=SKIPPED"), ["c"]);
      assert.deepEqual(await contents("project=newlabor"), ["b", "a"]);
      assert.deepEqual(await contents("line_user_id=U1"), ["c", "a"]);
      assert.deepEqual(await contents("event_type=postback"), ["a"]);
      assert.deepEqual(await contents(`from=${iso(-2)}`), ["c", "b"]);
      assert.deepEqual(await contents(`to=${iso(-2)}`), ["a"]);
      assert.deepEqual(await contents(`from=${iso(-2)}&to=${iso(-0.5)}`), ["b"]);
    });

    it("query ผิดรูปแบบตอบ 400 พร้อม field ที่ผิด", async () => {
      for (const query of ["limit=1000", "page=0", "status=DONE", "direction=UP", "from=not-a-date"]) {
        const response = await get(`/api/forward-logs?${query}`);
        assert.equal(response.status, 400, query);
        assert.equal((await json<{ code: string }>(response)).code, "VALIDATION_ERROR", query);
      }

      const body = await json<{ validation_errors: { field: string }[] }>(await get("/api/forward-logs?limit=1000"));
      assert.equal(body.validation_errors[0].field, "limit");
    });

    it("DB ผิดพลาดตอบ 500 โดยไม่เปิดเผยรายละเอียด", async () => {
      fakeDb.failNext = new Error("password authentication failed for user");
      const response = await get("/api/forward-logs");
      const body = await json<Record<string, unknown>>(response);

      assert.equal(response.status, 500);
      assert.equal(body.code, "INTERNAL_SERVER_ERROR");
      assert.doesNotMatch(JSON.stringify(body), /password/);
    });
  });

  describe("GET /api/forward-logs/:id", () => {
    it("คืน log เต็มรวม payload และ response_body", async () => {
      const row = seedForwardLog({ payload: { to: "U1", messages: [] }, responseBody: "{\"sentMessages\":[]}" });
      const body = await json<Record<string, unknown>>(await get(`/api/forward-logs/${row.id}`));

      assert.equal(body.id, row.id);
      assert.deepEqual(body.payload, { to: "U1", messages: [] });
      assert.equal(body.response_body, "{\"sentMessages\":[]}");
      assert.equal(body.created_at, (row.createdAt as Date).toISOString());
    });

    it("ไม่พบตอบ 404, id ไม่ใช่ตัวเลขตอบ 400", async () => {
      const missing = await get("/api/forward-logs/999");
      assert.equal(missing.status, 404);
      assert.equal((await json<{ code: string }>(missing)).code, "FORWARD_LOG_NOT_FOUND");

      const invalid = await get("/api/forward-logs/abc");
      assert.equal(invalid.status, 400);
      assert.equal((await json<{ message: string }>(invalid)).message, "Invalid id.");
    });
  });

  describe("rate limit", () => {
    const send = (ip: string, path = "/api/forward-logs") => app.request(path, { headers: { ...AUTH, "x-forwarded-for": ip } });

    it("เกินเพดานต่อ IP ตอบ 429 พร้อม header และ IP อื่นไม่ชน bucket เดียวกัน", async () => {
      for (let i = 0; i < 3; i += 1) assert.equal((await send("10.0.0.1")).status, 200);

      const limited = await send("10.0.0.1");
      assert.equal(limited.status, 429);
      assert.equal((await json<{ code: string }>(limited)).code, "RATE_LIMITED");
      assert.equal(limited.headers.get("RateLimit-Limit"), "3");
      assert.equal(limited.headers.get("RateLimit-Remaining"), "0");
      assert.ok(limited.headers.get("Retry-After"));
      assert.equal((await send("10.0.0.2")).status, 200);
    });

    it("ใช้ IP ขวาสุดของ X-Forwarded-For (เชื่อ proxy ชั้นเดียว)", async () => {
      for (let i = 0; i < 3; i += 1) await send(`1.1.1.${i}, 10.0.0.9`);
      assert.equal((await send("2.2.2.2, 10.0.0.9")).status, 429);
    });

    it("IPv6 ใน /56 เดียวกันใช้ bucket เดียวกัน และ IPv4-mapped นับเป็น IPv4", async () => {
      await send("2001:db8:abcd:12ff::1");
      await send("2001:db8:abcd:1200:ffff::9");
      await send("2001:db8:abcd:1201::5");
      assert.equal((await send("2001:db8:abcd:12aa::7")).status, 429);
      assert.equal((await send("2001:db8:abcd:1300::1")).status, 200);

      for (let i = 0; i < 3; i += 1) await send("::ffff:10.1.1.1");
      assert.equal((await send("10.1.1.1")).status, 429);
    });

    it("แต่ละกลุ่ม route นับแยกกัน (forward-logs กับ api-docs)", async () => {
      for (let i = 0; i < 3; i += 1) await send("10.0.0.3");
      assert.equal((await send("10.0.0.3")).status, 429);
      assert.equal((await send("10.0.0.3", "/api-docs/openapi.json")).status, 200);
    });
  });

  describe("ลบ log หมดอายุ (งานของ index.ts ทุก 6 ชั่วโมง)", () => {
    it("ลบเฉพาะ log ที่เก่ากว่า FORWARD_LOG_RETENTION_DAYS (90 วัน)", async () => {
      seedForwardLog({ content: "old", createdAt: new Date(Date.now() - 91 * DAY_MS) });
      seedForwardLog({ content: "recent", createdAt: new Date(Date.now() - 89 * DAY_MS) });

      assert.equal(await deleteExpiredForwardLogs(), 1);
      assert.deepEqual(fakeDb.rows.map((row) => row.content), ["recent"]);
    });
  });
});
