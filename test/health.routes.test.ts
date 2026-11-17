// Import Library
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

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
});
// CORS อ่านตอนโหลด app, CA cert ทำให้ database.ts ตัด ssl* ออกจาก URL
process.env.CORS_ORIGIN = "https://ops.example.com, https://admin.example.com";
process.env.DATABASE_URL = "postgresql://user:pass@db.test:5432/center_hook?sslmode=require&uselibpqcompat=true";
process.env.DATABASE_CA_CERT = "-----BEGIN CERTIFICATE-----\\nAAA\\n-----END CERTIFICATE-----";

// Config ฐานข้อมูลปลอม: แทน PrismaClient เพื่อให้โค้ดใน config/database.ts ทำงานจริงโดยไม่ต่อ DB
const fakeDb = {
  healthy: true,
  disconnected: 0,
  clientOptions: [] as unknown[],
  reset(): void {
    this.healthy = true;
  },
};

class FakePrismaClient {
  constructor(options: unknown) {
    fakeDb.clientOptions.push(options);
  }

  async $queryRaw(): Promise<unknown[]> {
    if (!fakeDb.healthy) throw new Error("connection refused");
    return [{ "?column?": 1 }];
  }

  async $disconnect(): Promise<void> {
    fakeDb.disconnected += 1;
  }
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

const { default: app } = require("../src/app") as typeof import("../src/app");
const { closePrisma } = require("../src/config/database") as typeof import("../src/config/database");

/* -------------------------------------- Tests -------------------------------------- */

describe("GET /", () => {
  beforeEach(() => fakeDb.reset());

  it("DB ปกติตอบ 200 พร้อมสถานะทุกส่วน", async () => {
    const response = await app.request("/");
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 200);
    assert.equal(body.status, "ok");
    assert.equal(body.database, "ok");
    assert.equal(typeof body.database_latency_ms, "number");
    assert.equal(typeof body.uptime_seconds, "number");
    assert.ok(!Number.isNaN(Date.parse(body.timestamp as string)));
  });

  it("DB ล่มตอบ 503 status error", async () => {
    fakeDb.healthy = false;
    const response = await app.request("/");
    const body = (await response.json()) as Record<string, unknown>;

    assert.equal(response.status, 503);
    assert.equal(body.status, "error");
    assert.equal(body.database, "unavailable");
  });

  it("ต่อ DB ด้วย CA cert: ตัด sslmode ออกจาก URL และตรวจ cert เสมอ", async () => {
    await app.request("/");
    const options = fakeDb.clientOptions[0] as { adapter: { externalPool?: unknown; config?: Record<string, unknown> } & Record<string, unknown> };
    const serialized = JSON.stringify(options.adapter, (_key, value) => (typeof value === "bigint" ? String(value) : value));

    assert.match(serialized, /postgresql:\/\/user:pass@db\.test:5432\/center_hook/);
    assert.doesNotMatch(serialized, /sslmode|uselibpqcompat/);
    assert.match(serialized, /"rejectUnauthorized":true/);
    assert.match(serialized, /BEGIN CERTIFICATE-----\\nAAA/);
  });
});

describe("request handling (ทุก route)", () => {
  it("ส่ง X-Request-Id ที่ client ส่งมากลับ ถ้ารูปแบบถูกต้อง", async () => {
    const response = await app.request("/", { headers: { "x-request-id": "abc-123" } });
    assert.equal(response.headers.get("x-request-id"), "abc-123");
  });

  it("สร้าง request id ใหม่เมื่อค่าที่ส่งมามีอักขระต้องห้าม (กัน log injection)", async () => {
    const response = await app.request("/", { headers: { "x-request-id": "bad id\twith tab" } });
    assert.match(response.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  });

  it("route ที่ไม่มีตอบ 404 รูปแบบ error มาตรฐาน", async () => {
    const response = await app.request("/nope", { headers: { "x-request-id": "req-404" } });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { status_code: 404, code: "NOT_FOUND", message: "Route not found.", request_id: "req-404" });
  });

  it("CORS อนุญาตเฉพาะ origin ใน CORS_ORIGIN", async () => {
    const preflight = (origin: string) =>
      app.request("/api/forward-logs", { method: "OPTIONS", headers: { origin, "access-control-request-method": "GET" } });

    assert.equal((await preflight("https://admin.example.com")).headers.get("access-control-allow-origin"), "https://admin.example.com");
    assert.equal((await preflight("https://evil.example.com")).headers.get("access-control-allow-origin"), null);
  });

  it("ใส่ security headers ทุก response", async () => {
    const response = await app.request("/");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  });
});

describe("shutdown (index.ts)", () => {
  it("closePrisma ปิด connection ครั้งเดียว เรียกซ้ำไม่พัง", async () => {
    const before = fakeDb.disconnected;
    await closePrisma();
    await closePrisma();
    assert.equal(fakeDb.disconnected, before + 1);
  });
});
