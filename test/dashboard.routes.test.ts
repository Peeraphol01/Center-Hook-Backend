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
  RATE_LIMIT_WINDOW_MS: "60000",
  RATE_LIMIT_MAX_REQUESTS: "3",
  ...TEST_AUTH_ENV,
});

// Config ฐานข้อมูลปลอมของบัญชี/สิทธิ์/session (ใช้ login จริงผ่าน /api/auth/login)
const authDb = createFakeAuthDb();

// Type แถวของ forward_logs ในฐานข้อมูลปลอม (ชื่อ field แบบ Prisma)
type FakeRow = {
  id: number;
  project: string;
  direction: string;
  status: string;
  lineUserId: string | null;
  eventType: string;
  httpStatus: number | null;
  errorMessage: string | null;
  durationMs: number;
  createdAt: Date;
};

const fakeDb = { rows: [] as FakeRow[], nextId: 1 };

// Config offset ของ Asia/Bangkok (+7 ชั่วโมง ไม่มีเวลาออมแสง) ใช้จำลองการตัดช่วงเวลาของ SQL
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000;

// Function ตรวจว่าแถวอยู่ในช่วง [gte, lt) และ project ตรง (where จาก repository)
function inRange(row: FakeRow, where: { createdAt: { gte: Date; lt: Date }; project?: string; status?: string }): boolean {
  return (
    row.createdAt >= where.createdAt.gte &&
    row.createdAt < where.createdAt.lt &&
    (where.project === undefined || row.project === where.project) &&
    (where.status === undefined || row.status === where.status)
  );
}

class FakePrismaClient {
  account = authDb.delegates.account;
  accountPermission = authDb.delegates.accountPermission;
  userSession = authDb.delegates.userSession;
  auditLog = authDb.delegates.auditLog;
  $transaction = async <T>(work: (tx: this) => Promise<T>) => work(this);

  // จำลอง SQL ของ dashboard.repository (ค่า parameter เรียงตาม template)
  $queryRaw = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (!sql.includes("forward_logs")) return authDb.delegates.$queryRaw();

    const isBucket = sql.includes("date_trunc");
    const [interval, , , start, end, project] = isBucket ? values : [null, null, null, ...values];
    const rows = fakeDb.rows.filter((row) =>
      inRange(row, { createdAt: { gte: new Date(start as string), lt: new Date(end as string) }, project: (project as string | null) ?? undefined })
    );

    if (!isBucket) return [{ count: new Set(rows.map((row) => row.lineUserId).filter(Boolean)).size }];

    const unitMs = interval === "hour" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
    const groups = new Map<string, { bucket: Date; status: string; count: number }>();
    for (const row of rows) {
      const local = row.createdAt.getTime() + BANGKOK_OFFSET_MS;
      const bucket = new Date(Math.floor(local / unitMs) * unitMs - BANGKOK_OFFSET_MS);
      const key = `${bucket.getTime()}|${row.status}`;
      const group = groups.get(key) ?? { bucket, status: row.status, count: 0 };
      group.count += 1;
      groups.set(key, group);
    }
    return [...groups.values()];
  };

  forwardLog = {
    groupBy: async ({ where }: { where: { createdAt: { gte: Date; lt: Date }; project?: string } }) => {
      const groups = new Map<string, { project: string; direction: string; status: string; _count: { _all: number }; _sum: { durationMs: number } }>();
      for (const row of fakeDb.rows.filter((item) => inRange(item, where))) {
        const key = `${row.project}|${row.direction}|${row.status}`;
        const group = groups.get(key) ?? { project: row.project, direction: row.direction, status: row.status, _count: { _all: 0 }, _sum: { durationMs: 0 } };
        group._count._all += 1;
        group._sum.durationMs += row.durationMs;
        groups.set(key, group);
      }
      return [...groups.values()];
    },
    findMany: async ({ where, take }: { where: { createdAt: { gte: Date; lt: Date }; project?: string; status?: string }; take: number }) =>
      fakeDb.rows.filter((row) => inRange(row, where)).sort((a, b) => b.id - a.id).slice(0, take),
  };
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

// Function เพิ่ม forward log ลงฐานข้อมูลปลอม (at = เวลา UTC)
function seed(at: string, overrides: Partial<FakeRow> = {}): FakeRow {
  const row: FakeRow = {
    project: "default", direction: "INBOUND", status: "SUCCESS", lineUserId: "U1", eventType: "message",
    httpStatus: 200, errorMessage: null, durationMs: 100,
    ...overrides,
    id: fakeDb.nextId++,
    createdAt: new Date(at),
  };
  fakeDb.rows.push(row);
  return row;
}

const { default: app } = require("../src/app") as typeof import("../src/app");
const { clearRateLimitBuckets } = require("../src/middlewares/rate-limit.middleware") as typeof import("../src/middlewares/rate-limit.middleware");

/* -------------------------------------- Test Helpers -------------------------------------- */

let AUTH: Record<string, string> = {};

// Function เรียก API (ล้างตัวนับ rate limit ก่อน เพดานใน test-env คือ 3)
async function get(path: string, headers: Record<string, string> = AUTH): Promise<Response> {
  clearRateLimitBuckets();
  return app.request(path, { headers });
}

type DashboardBody = import("../src/types/dashboard.types").DashboardResponse;
const dashboard = async (query = "") => (await (await get(`/api/dashboard${query}`)).json()) as DashboardBody;

/* -------------------------------------- Tests -------------------------------------- */

describe("GET /api/dashboard", () => {
  beforeEach(async () => {
    fakeDb.rows = [];
    fakeDb.nextId = 1;
    authDb.reset();
    await authDb.seedAccount({ username: "viewer", role: "admin", permissions: ["forward_logs:read"] });
    await authDb.seedAccount({ username: "nolog", role: "admin", permissions: ["webhooks:read"] });
    AUTH = await loginHeaders(app, "viewer");
  });

  afterEach(() => {
    clearRateLimitBuckets();
  });

  it("ต้อง login และมีสิทธิ์ forward_logs:read", async () => {
    assert.equal((await get("/api/dashboard", {})).status, 401);

    const forbidden = await get("/api/dashboard", await loginHeaders(app, "nolog"));
    assert.equal(forbidden.status, 403);
    assert.deepEqual(((await forbidden.json()) as { required_permissions: string[] }).required_permissions, ["forward_logs:read"]);
  });

  it("ไม่ส่งวันที่ = วันนี้ตามเวลาไทย แยกกราฟรายชั่วโมง 24 ช่อง", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok" }).format(new Date());
    const body = await dashboard();

    assert.equal(body.range.from, today);
    assert.equal(body.range.to, today);
    assert.equal(body.range.interval, "hour");
    assert.equal(body.timeseries.length, 24);
  });

  it("from วันเดียว = ทั้งวันตามเวลาไทย (00:00-23:59 น.) และสรุปตัวเลขถูกต้อง", async () => {
    // 2026-11-05 เวลาไทย = 2026-11-04T17:00Z ถึง 2026-11-05T17:00Z
    seed("2026-11-04T16:59:59Z"); // 23:59 น. ของวันที่ 4 ไม่นับ
    seed("2026-11-04T17:30:00Z", { project: "shop_a", durationMs: 200 }); // 00:30 น.
    seed("2026-11-05T03:10:00Z", { project: "shop_a", status: "FAILED", httpStatus: 500, errorMessage: "boom", lineUserId: "U2", durationMs: 400 }); // 10:10 น.
    seed("2026-11-05T03:20:00Z", { project: "shop_a", status: "SKIPPED", durationMs: 0, lineUserId: null }); // 10:20 น.
    seed("2026-11-05T04:00:00Z", { direction: "OUTBOUND", eventType: "push", durationMs: 300 }); // 11:00 น.
    seed("2026-11-05T17:00:00Z"); // 00:00 น. ของวันที่ 6 ไม่นับ

    const body = await dashboard("?from=2026-11-05");

    assert.deepEqual(body.range, {
      from: "2026-11-05", to: "2026-11-05", timezone: "Asia/Bangkok", interval: "hour",
      start: "2026-11-04T17:00:00.000Z", end: "2026-11-05T17:00:00.000Z",
    });
    assert.deepEqual(body.totals, {
      total: 4, success: 2, failed: 1, skipped: 1, success_rate: 0.6667,
      inbound: 3, outbound: 1, active_line_users: 2, avg_duration_ms: 300,
    });

    assert.equal(body.timeseries.length, 24);
    assert.equal(body.timeseries[0].bucket, "2026-11-04T17:00:00.000Z");
    assert.deepEqual(body.timeseries[10], { bucket: "2026-11-05T03:00:00.000Z", total: 2, success: 0, failed: 1, skipped: 1 });
    assert.equal(body.timeseries.reduce((sum, item) => sum + item.total, 0), 4);

    assert.deepEqual(body.by_project, [
      { project: "shop_a", total: 3, success: 1, failed: 1, skipped: 1, success_rate: 0.5, avg_duration_ms: 300 },
      { project: "default", total: 1, success: 1, failed: 0, skipped: 0, success_rate: 1, avg_duration_ms: 300 },
    ]);
    assert.deepEqual(body.recent_failures.map((item) => [item.project, item.http_status, item.error_message]), [["shop_a", 500, "boom"]]);
  });

  it("from-to หลายวัน = แยกกราฟรายวัน นับรวมวันสุดท้าย", async () => {
    seed("2026-11-04T18:00:00Z"); // 5 พ.ย. 01:00 น.
    seed("2026-11-06T16:00:00Z"); // 6 พ.ย. 23:00 น.
    seed("2026-11-07T16:59:00Z"); // 7 พ.ย. 23:59 น.
    seed("2026-11-07T17:00:00Z"); // 8 พ.ย. ไม่นับ

    const body = await dashboard("?from=2026-11-05&to=2026-11-07");

    assert.equal(body.range.interval, "day");
    assert.equal(body.range.end, "2026-11-07T17:00:00.000Z");
    assert.deepEqual(body.timeseries.map((item) => [item.bucket, item.total]), [
      ["2026-11-04T17:00:00.000Z", 1],
      ["2026-11-05T17:00:00.000Z", 1],
      ["2026-11-06T17:00:00.000Z", 1],
    ]);
    assert.equal(body.totals.total, 3);
  });

  it("กรองตาม project และไม่มีข้อมูลได้ success_rate/avg_duration_ms เป็น null", async () => {
    seed("2026-11-05T03:00:00Z", { project: "shop_a" });
    seed("2026-11-05T03:00:00Z", { project: "shop_b" });

    assert.deepEqual((await dashboard("?from=2026-11-05&project=shop_b")).by_project.map((item) => item.project), ["shop_b"]);

    const empty = await dashboard("?from=2026-11-05&project=none");
    assert.equal(empty.totals.total, 0);
    assert.equal(empty.totals.success_rate, null);
    assert.equal(empty.totals.avg_duration_ms, null);
  });

  it("วันที่ผิดรูปแบบหรือช่วงไม่ถูกต้องตอบ 400 VALIDATION_ERROR", async () => {
    for (const [query, field] of [
      ["?from=05/11/2026", "from"],
      ["?from=2026-02-30", "from"],
      ["?to=2026-11-05", "from"],
      ["?from=2026-11-05&to=2026-11-04", "to"],
      ["?from=2026-01-01&to=2026-12-31", "to"],
    ]) {
      const response = await get(`/api/dashboard${query}`);
      const body = (await response.json()) as { code: string; validation_errors: { field: string }[] };

      assert.equal(response.status, 400, query);
      assert.equal(body.code, "VALIDATION_ERROR", query);
      assert.equal(body.validation_errors[0].field, field, query);
    }
  });
});
