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
  LINE_CHANNEL_ACCESS_TOKEN: "test-line-access-token",
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX_REQUESTS: "100",
  ...TEST_AUTH_ENV,
});

const authDb = createFakeAuthDb();

type Row = Record<string, unknown> & { id: number };

const fakeDb = {
  logs: [] as Row[],
  profiles: [] as Record<string, unknown>[],
  nextId: 1,
  reset(): void {
    this.logs = [];
    this.profiles = [];
    this.nextId = 1;
  },
};

// Function ตรวจเงื่อนไข where แบบ Prisma ที่ repository ใช้ (AND/OR, in, not, lt, contains แบบไม่สนตัวพิมพ์)
function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === "AND") return (condition as Record<string, unknown>[]).every((item) => matches(row, item));
    if (key === "OR") return (condition as Record<string, unknown>[]).some((item) => matches(row, item));

    const value = row[key];

    if (condition !== null && typeof condition === "object") {
      const { in: inList, not, lt, contains } = condition as { in?: unknown[]; not?: unknown; lt?: number; contains?: string };
      if (inList && !inList.includes(value)) return false;
      if ("not" in (condition as object) && value === not) return false;
      if (lt !== undefined && !((value as number) < lt)) return false;
      if (contains !== undefined && !String(value ?? "").toLowerCase().includes(contains.toLowerCase())) return false;
      return true;
    }

    return value === condition;
  });
}

const omitKeys = (row: Row, omit: Record<string, boolean> = {}) => Object.fromEntries(Object.entries(row).filter(([key]) => !omit[key]));

class FakePrismaClient {
  account = authDb.delegates.account;
  accountPermission = authDb.delegates.accountPermission;
  userSession = authDb.delegates.userSession;
  $queryRaw = authDb.delegates.$queryRaw;
  $transaction = async <T>(work: (tx: this) => Promise<T>) => work(this);

  forwardLog = {
    findMany: async ({ where, take, omit }: { where?: Record<string, unknown>; take?: number; omit?: Record<string, boolean> }) =>
      fakeDb.logs
        .filter((row) => matches(row, where))
        .sort((a, b) => b.id - a.id)
        .slice(0, take)
        .map((row) => omitKeys(row, omit)),
    groupBy: async ({ where, skip = 0, take }: { where?: Record<string, unknown>; skip?: number; take?: number }) => {
      const groups = new Map<unknown, { lineUserId: unknown; _max: { id: number }; _count: { _all: number } }>();
      for (const row of fakeDb.logs.filter((item) => matches(item, where))) {
        const group = groups.get(row.lineUserId) ?? { lineUserId: row.lineUserId, _max: { id: 0 }, _count: { _all: 0 } };
        group._max.id = Math.max(group._max.id, row.id);
        group._count._all += 1;
        groups.set(row.lineUserId, group);
      }
      return [...groups.values()].sort((a, b) => b._max.id - a._max.id).slice(skip, take === undefined ? undefined : skip + take);
    },
  };

  lineProfile = {
    findMany: async ({ where, take }: { where?: Record<string, unknown>; take?: number }) =>
      fakeDb.profiles.filter((row) => matches(row, where)).slice(0, take),
    upsert: async ({ where, create, update }: { where: { lineUserId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
      const existing = fakeDb.profiles.find((row) => row.lineUserId === where.lineUserId);
      if (existing) Object.assign(existing, update);
      else fakeDb.profiles.push({ ...create });
    },
  };
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

// Function เพิ่ม log ลงฐานข้อมูลปลอม
function seedLog(overrides: Partial<Row> = {}): Row {
  const row = {
    direction: "INBOUND", requestId: "req-1", webhookEventId: null, project: "default", targetUrl: null, lineUserId: "U1",
    eventType: "message", messageType: "text", content: "hello", payload: { type: "message" }, status: "SUCCESS", httpStatus: 200,
    responseBody: "{}", errorMessage: null, attempts: 1, durationMs: 5, forwardedAt: new Date(), createdAt: new Date(),
    ...overrides,
    id: fakeDb.nextId++,
  } as Row;
  fakeDb.logs.push(row);
  return row;
}

// Config LINE API ปลอม: ตอบชื่อ "User <id>" ยกเว้น id ที่อยู่ใน notFound
const lineApi = { calls: [] as string[], notFound: new Set<string>() };
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);

  if (!url.startsWith("https://api.line.me/")) {
    return realFetch(input, init);
  }

  lineApi.calls.push(url);
  assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-line-access-token");
  const id = decodeURIComponent(url.split("/").filter((part) => part !== "summary").at(-1)!);

  if (lineApi.notFound.has(id)) {
    return new Response(JSON.stringify({ message: "Not found" }), { status: 404 });
  }

  const body = url.includes("/group/")
    ? { groupId: id, groupName: `Group ${id}`, pictureUrl: `https://img.test/${id}` }
    : { userId: id, displayName: `User ${id}`, pictureUrl: `https://img.test/${id}` };
  return new Response(JSON.stringify(body), { status: 200 });
}) as typeof fetch;

const { default: app } = require("../src/app") as typeof import("../src/app");
const { clearRateLimitBuckets } = require("../src/middlewares/rate-limit.middleware") as typeof import("../src/middlewares/rate-limit.middleware");

/* -------------------------------------- Test Helpers -------------------------------------- */

let AUTH: Record<string, string> = {};

async function get<T = Record<string, unknown>>(path: string, headers: Record<string, string> = AUTH): Promise<{ status: number; body: T }> {
  clearRateLimitBuckets();
  const response = await app.request(path, { headers });
  return { status: response.status, body: (await response.json()) as T };
}

type ListBody = {
  data: { line_user_id: string; log_count: number; profile: { display_name: string | null; picture_url: string | null }; last_log: Record<string, unknown> }[];
  pagination: { page: number; limit: number; has_more: boolean };
};

type LogsBody = { line_user_id: string; profile: { display_name: string | null }; data: Record<string, unknown>[]; has_more: boolean };

/* -------------------------------------- Tests -------------------------------------- */

describe("/api/forward-logs/conversations", () => {
  beforeEach(async () => {
    fakeDb.reset();
    authDb.reset();
    lineApi.calls = [];
    lineApi.notFound.clear();
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-access-token";
    await authDb.seedAccount({ username: "viewer", role: "admin", permissions: ["forward_logs:read"] });
    await authDb.seedAccount({ username: "nolog", role: "admin", permissions: ["webhooks:read"] });
    AUTH = await loginHeaders(app, "viewer");
  });

  afterEach(() => {
    clearRateLimitBuckets();
  });

  describe("GET /api/forward-logs/conversations", () => {
    it("จัดกลุ่มตาม LINE user เรียงตามข้อความล่าสุด พร้อมจำนวน ข้อความล่าสุด และโปรไฟล์จาก LINE", async () => {
      seedLog({ lineUserId: "U1", content: "u1-first" });
      seedLog({ lineUserId: "U2", content: "u2-only" });
      seedLog({ lineUserId: "U1", content: "u1-reply", direction: "OUTBOUND", eventType: "push" });
      seedLog({ lineUserId: null, content: "no-user" });

      const { status, body } = await get<ListBody>("/api/forward-logs/conversations");

      assert.equal(status, 200);
      assert.deepEqual(body.data.map((item) => [item.line_user_id, item.log_count, item.last_log.content]), [["U1", 2, "u1-reply"], ["U2", 1, "u2-only"]]);
      assert.deepEqual(body.data[0].profile, { display_name: "User U1", picture_url: "https://img.test/U1" });
      assert.ok(!("payload" in body.data[0].last_log) && !("response_body" in body.data[0].last_log));
      assert.deepEqual(body.pagination, { page: 1, limit: 20, has_more: false });
    });

    it("โปรไฟล์ถูก cache ใน DB ไม่ถาม LINE ซ้ำ", async () => {
      seedLog({ lineUserId: "U1" });

      await get("/api/forward-logs/conversations");
      await get("/api/forward-logs/conversations");

      assert.equal(lineApi.calls.length, 1);
      assert.equal(fakeDb.profiles.length, 1);
    });

    it("group (C...) ใช้ชื่อกลุ่ม | LINE ตอบ 404 ได้ชื่อ null | id อื่น (R...) ไม่ถาม LINE", async () => {
      seedLog({ lineUserId: "Cgroup1" });
      seedLog({ lineUserId: "Ublocked" });
      seedLog({ lineUserId: "Rroom1" });
      lineApi.notFound.add("Ublocked");

      const { body } = await get<ListBody>("/api/forward-logs/conversations");
      const names = Object.fromEntries(body.data.map((item) => [item.line_user_id, item.profile.display_name]));

      assert.deepEqual(names, { Cgroup1: "Group Cgroup1", Ublocked: null, Rroom1: null });
      assert.ok(lineApi.calls.some((url) => url.endsWith("/v2/bot/group/Cgroup1/summary")));
      assert.ok(!lineApi.calls.some((url) => url.includes("Rroom1")));
    });

    it("ไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN ก็ตอบได้ (ไม่มีชื่อ/รูป)", async () => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      seedLog({ lineUserId: "U1" });

      const { status, body } = await get<ListBody>("/api/forward-logs/conversations");

      assert.equal(status, 200);
      assert.deepEqual(body.data[0].profile, { display_name: null, picture_url: null });
      assert.equal(lineApi.calls.length, 0);
    });

    it("กรองตาม project และค้นหาด้วย LINE user id บางส่วนหรือชื่อโปรไฟล์", async () => {
      seedLog({ lineUserId: "Uaaa111", project: "newlabor" });
      seedLog({ lineUserId: "Ubbb222", project: "default" });
      fakeDb.profiles.push({ lineUserId: "Ubbb222", displayName: "สมชาย ใจดี", pictureUrl: null, fetchedAt: new Date() });

      const ids = async (query: string) => (await get<ListBody>(`/api/forward-logs/conversations?${query}`)).body.data.map((item) => item.line_user_id);

      assert.deepEqual(await ids("project=newlabor"), ["Uaaa111"]);
      assert.deepEqual(await ids("search=AAA1"), ["Uaaa111"]);
      assert.deepEqual(await ids(`search=${encodeURIComponent("สมชาย")}`), ["Ubbb222"]);
      assert.deepEqual(await ids("search=nobody"), []);
    });

    it("แบ่งหน้าด้วย has_more", async () => {
      for (const id of ["U1", "U2", "U3"]) seedLog({ lineUserId: id });

      const first = await get<ListBody>("/api/forward-logs/conversations?limit=2");
      const second = await get<ListBody>("/api/forward-logs/conversations?limit=2&page=2");

      assert.deepEqual(first.body.data.map((item) => item.line_user_id), ["U3", "U2"]);
      assert.equal(first.body.pagination.has_more, true);
      assert.deepEqual(second.body.data.map((item) => item.line_user_id), ["U1"]);
      assert.equal(second.body.pagination.has_more, false);
    });

    it("ไม่มีสิทธิ์ forward_logs:read ตอบ 403 และ query ผิดตอบ 400", async () => {
      assert.equal((await get("/api/forward-logs/conversations", await loginHeaders(app, "nolog"))).status, 403);
      assert.equal((await get("/api/forward-logs/conversations?limit=500")).status, 400);
    });
  });

  describe("GET /api/forward-logs/conversations/:line_user_id", () => {
    it("ข้อความของ user ใหม่ไปเก่า มี payload ไม่มี response_body โหลดย้อนหลังด้วย before_id", async () => {
      for (let i = 1; i <= 5; i += 1) seedLog({ lineUserId: "U1", content: `m${i}`, payload: { n: i } });
      seedLog({ lineUserId: "U2", content: "other" });

      const first = await get<LogsBody>("/api/forward-logs/conversations/U1?limit=2");
      const lastId = first.body.data.at(-1)!.id;
      const older = await get<LogsBody>(`/api/forward-logs/conversations/U1?limit=10&before_id=${lastId}`);

      assert.equal(first.status, 200);
      assert.equal(first.body.profile.display_name, "User U1");
      assert.deepEqual(first.body.data.map((item) => item.content), ["m5", "m4"]);
      assert.deepEqual(first.body.data[0].payload, { n: 5 });
      assert.ok(!("response_body" in first.body.data[0]));
      assert.equal(first.body.has_more, true);
      assert.deepEqual(older.body.data.map((item) => item.content), ["m3", "m2", "m1"]);
      assert.equal(older.body.has_more, false);
    });

    it("กรองตาม project ได้", async () => {
      seedLog({ lineUserId: "U1", project: "newlabor", content: "a" });
      seedLog({ lineUserId: "U1", project: "default", content: "b" });

      const { body } = await get<LogsBody>("/api/forward-logs/conversations/U1?project=newlabor");

      assert.deepEqual(body.data.map((item) => item.content), ["a"]);
    });

    it("LINE user id ผิดรูปแบบตอบ 400", async () => {
      const { status, body } = await get<{ code: string }>("/api/forward-logs/conversations/bad%20id");

      assert.equal(status, 400);
      assert.equal(body.code, "VALIDATION_ERROR");
    });
  });
});
