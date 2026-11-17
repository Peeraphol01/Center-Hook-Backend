// Import Library
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";
// Import Helpers
import { createFakeAuthDb, loginHeaders, TEST_AUTH_ENV } from "./helpers/fake-auth-db";

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

// Config ฐานข้อมูลปลอมของบัญชี/สิทธิ์/session
const authDb = createFakeAuthDb();

// Type แถวของ webhooks ในฐานข้อมูลปลอม (ชื่อ field แบบ Prisma)
type FakeWebhook = { id: number; smmApp: string | null; webhookUrl: string; createdAt: Date; updatedAt: Date };

// Config ฐานข้อมูลปลอม: ตาราง webhooks ใน memory (unique smm_app เหมือน DB จริง)
const fakeDb = {
  webhooks: [] as FakeWebhook[],
  nextId: 1,
  reset(): void {
    this.webhooks = [];
    this.nextId = 1;
  },
};

// Function จำลอง unique constraint ของ Postgres (NULL ซ้ำได้) โยน P2002 แบบ Prisma
function assertUnique(candidate: Partial<FakeWebhook>, ignoreId?: number): void {
  const value = candidate.smmApp;
  if (value != null && fakeDb.webhooks.some((webhook) => webhook.id !== ignoreId && webhook.smmApp === value)) {
    throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
  }
}

class FakePrismaClient {
  account = authDb.delegates.account;
  accountPermission = authDb.delegates.accountPermission;
  userSession = authDb.delegates.userSession;
  auditLog = authDb.delegates.auditLog;
  $queryRaw = authDb.delegates.$queryRaw;
  $transaction = async <T>(work: (tx: this) => Promise<T>) => work(this);

  webhook = {
    findMany: async () => [...fakeDb.webhooks].sort((a, b) => a.id - b.id),
    create: async ({ data }: { data: Omit<FakeWebhook, "id" | "createdAt" | "updatedAt"> }) => {
      assertUnique(data);
      const webhook = { ...data, id: fakeDb.nextId++, createdAt: new Date(), updatedAt: new Date() };
      fakeDb.webhooks.push(webhook);
      return webhook;
    },
    update: async ({ where, data }: { where: { id: number }; data: Partial<FakeWebhook> }) => {
      const webhook = fakeDb.webhooks.find((item) => item.id === where.id);
      if (!webhook) throw Object.assign(new Error("Record not found"), { code: "P2025" });
      assertUnique(data, where.id);
      Object.assign(webhook, data, { updatedAt: new Date() });
      return webhook;
    },
    deleteMany: async ({ where }: { where: { id: number } }) => {
      const before = fakeDb.webhooks.length;
      fakeDb.webhooks = fakeDb.webhooks.filter((webhook) => webhook.id !== where.id);
      return { count: before - fakeDb.webhooks.length };
    },
  };

  forwardLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data, id: 1, createdAt: new Date() }),
  };
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

const { default: app } = require("../src/app") as typeof import("../src/app");

/* -------------------------------------- Test Helpers -------------------------------------- */

// Config header ของบัญชีที่มีสิทธิ์ webhooks ครบ (login ใหม่ทุก test ใน beforeEach)
let AUTH: Record<string, string> = {};

type WebhookBody = { id: number; smm_app: string | null; webhook_url: string; created_at: string; updated_at: string };

// Function เรียก /api/webhooks ด้วย access token (ค่า default อ่าน AUTH ตอนเรียก)
function call(method: string, path: string, body?: unknown, headers: Record<string, string> = AUTH): Promise<Response> {
  return Promise.resolve(app.request(path, {
    method,
    headers: { ...headers, ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

const json = async <T>(response: Response) => (await response.json()) as T;
const create = (body: unknown) => call("POST", "/api/webhooks", body);

const LABOR = { smm_app: "newlabor", webhook_url: "https://labor.example.com/api/line/webhook" };
const DEFAULT = { smm_app: null, webhook_url: "https://other.example.com/webhook" };

/* -------------------------------------- Tests -------------------------------------- */

describe("/api/webhooks", () => {
  beforeEach(async () => {
    fakeDb.reset();
    authDb.reset();
    await authDb.seedAccount({ username: "editor", role: "admin", permissions: ["webhooks:read", "webhooks:create", "webhooks:update", "webhooks:delete"] });
    await authDb.seedAccount({ username: "reader", role: "admin", permissions: ["webhooks:read"] });
    AUTH = await loginHeaders(app, "editor");
  });

  it("ต้องใส่ access token ทุกเส้น", async () => {
    for (const [method, path] of [["GET", "/api/webhooks"], ["POST", "/api/webhooks"], ["PATCH", "/api/webhooks/newlabor"], ["DELETE", "/api/webhooks/default"]]) {
      const response = await call(method, path, undefined, {});
      assert.equal(response.status, 401, `${method} ${path}`);
    }
  });

  it("แต่ละเส้นต้องมีสิทธิ์ของตัวเอง (webhooks:read ดูได้อย่างเดียว)", async () => {
    const reader = await loginHeaders(app, "reader");

    assert.equal((await call("GET", "/api/webhooks", undefined, reader)).status, 200);

    for (const [method, path, permission] of [["POST", "/api/webhooks", "webhooks:create"], ["PATCH", "/api/webhooks/newlabor", "webhooks:update"], ["DELETE", "/api/webhooks/default", "webhooks:delete"]]) {
      const response = await call(method, path, LABOR, reader);
      const body = await json<{ code: string; required_permissions: string[] }>(response);

      assert.equal(response.status, 403, `${method} ${path}`);
      assert.deepEqual(body.required_permissions, [permission], `${method} ${path}`);
    }
  });

  describe("POST /api/webhooks", () => {
    it("สร้าง webhook แล้วตอบข้อมูลที่บันทึก", async () => {
      const response = await create(LABOR);
      const body = await json<WebhookBody>(response);

      assert.equal(response.status, 201);
      assert.deepEqual(body, { id: 1, smm_app: "newlabor", webhook_url: LABOR.webhook_url, created_at: body.created_at, updated_at: body.updated_at });
    });

    it("webhook default (smm_app = null) มีได้แถวเดียว", async () => {
      const first = await json<WebhookBody>(await create(DEFAULT));
      assert.equal(first.smm_app, null);

      const second = await create({ ...DEFAULT, webhook_url: "https://another.example.com/webhook" });
      assert.equal(second.status, 409);
      assert.equal((await json<{ code: string }>(second)).code, "DEFAULT_WEBHOOK_EXISTS");
    });

    it("smm_app ซ้ำตอบ 409 WEBHOOK_CONFLICT", async () => {
      await create(LABOR);
      const duplicate = await create({ ...LABOR, webhook_url: "https://labor2.example.com/webhook" });

      assert.equal(duplicate.status, 409);
      assert.equal((await json<{ code: string }>(duplicate)).code, "WEBHOOK_CONFLICT");
    });

    it("ข้อมูลผิดรูปแบบตอบ 400", async () => {
      const cases = [
        { ...LABOR, smm_app: "New Labor" },
        { ...LABOR, webhook_url: "ftp://labor.example.com" },
        { ...LABOR, webhook_url: "not a url" },
        { ...LABOR, webhook_url: "" },
        { webhook_url: LABOR.webhook_url },
        { ...LABOR, smm_app: "" },
        { ...LABOR, smm_app: "default" },
      ];

      for (const body of cases) {
        assert.equal((await create(body)).status, 400, JSON.stringify(body));
      }
      assert.equal(fakeDb.webhooks.length, 0);
    });
  });

  describe("GET /api/webhooks", () => {
    it("คืนทุก webhook เรียงตาม id", async () => {
      await create(LABOR);
      await create(DEFAULT);
      const response = await call("GET", "/api/webhooks");
      const body = await json<{ data: WebhookBody[] }>(response);

      assert.equal(response.status, 200);
      assert.deepEqual(body.data.map((webhook) => [webhook.id, webhook.smm_app, webhook.webhook_url]), [[1, "newlabor", LABOR.webhook_url], [2, null, DEFAULT.webhook_url]]);
    });
  });

  describe("PATCH /api/webhooks/:smm_app", () => {
    it("แก้ webhook_url โดยอ้างด้วย smm_app", async () => {
      await create(LABOR);
      const response = await call("PATCH", "/api/webhooks/newlabor", { webhook_url: "https://new.example.com/hook" });
      const body = await json<WebhookBody>(response);

      assert.equal(response.status, 200);
      assert.deepEqual([body.smm_app, body.webhook_url], ["newlabor", "https://new.example.com/hook"]);
    });

    it("/api/webhooks/default คือ webhook default (smm_app = null)", async () => {
      await create(LABOR);
      await create(DEFAULT);
      const body = await json<WebhookBody>(await call("PATCH", "/api/webhooks/default", { webhook_url: "https://default-v2.example.com/hook" }));

      assert.deepEqual([body.id, body.smm_app, body.webhook_url], [2, null, "https://default-v2.example.com/hook"]);
      assert.equal(fakeDb.webhooks[0].webhookUrl, LABOR.webhook_url);
    });

    it("ย้ายเป็น webhook default ได้ และถ้ามี default อยู่แล้วตอบ 409", async () => {
      await create(LABOR);
      const moved = await json<WebhookBody>(await call("PATCH", "/api/webhooks/newlabor", { smm_app: null }));
      assert.equal(moved.smm_app, null);

      await create({ ...LABOR, smm_app: "shop" });
      const conflict = await call("PATCH", "/api/webhooks/shop", { smm_app: null });
      assert.equal(conflict.status, 409);
      assert.equal((await json<{ code: string }>(conflict)).code, "DEFAULT_WEBHOOK_EXISTS");

      assert.equal((await call("PATCH", "/api/webhooks/default", { webhook_url: "https://renamed.example.com/hook" })).status, 200);
    });

    it("เปลี่ยน smm_app ได้ แล้วต้องอ้างด้วยชื่อใหม่", async () => {
      await create(LABOR);
      assert.equal((await call("PATCH", "/api/webhooks/newlabor", { smm_app: "labor2" })).status, 200);
      assert.equal((await call("PATCH", "/api/webhooks/newlabor", { webhook_url: "https://x.example.com/hook" })).status, 404);
      assert.equal((await call("PATCH", "/api/webhooks/labor2", { webhook_url: "https://x.example.com/hook" })).status, 200);
    });

    it("smm_app ซ้ำตอบ 409, ไม่พบตอบ 404, body ว่าง / smm_app ผิดรูปแบบ / ตั้งเป็น default ตอบ 400", async () => {
      await create(LABOR);
      await create({ ...LABOR, smm_app: "shop" });

      assert.equal((await call("PATCH", "/api/webhooks/shop", { smm_app: "newlabor" })).status, 409);
      assert.equal((await call("PATCH", "/api/webhooks/unknown", { webhook_url: "https://x.example.com/hook" })).status, 404);
      assert.equal((await call("PATCH", "/api/webhooks/default", { webhook_url: "https://x.example.com/hook" })).status, 404);
      assert.equal((await call("PATCH", "/api/webhooks/newlabor", {})).status, 400);
      assert.equal((await call("PATCH", "/api/webhooks/New%20Labor", { webhook_url: "https://x.example.com/hook" })).status, 400);
      assert.equal((await call("PATCH", "/api/webhooks/shop", { smm_app: "default" })).status, 400);
    });
  });

  describe("DELETE /api/webhooks/:smm_app", () => {
    it("ลบได้ ลบซ้ำตอบ 404", async () => {
      await create(LABOR);

      assert.deepEqual(await json(await call("DELETE", "/api/webhooks/newlabor")), { message: "Webhook deleted." });
      assert.equal(fakeDb.webhooks.length, 0);
      assert.equal((await call("DELETE", "/api/webhooks/newlabor")).status, 404);
    });

    it("ลบ webhook default ด้วย /api/webhooks/default โดยไม่กระทบแถวอื่น", async () => {
      await create(LABOR);
      await create(DEFAULT);

      assert.equal((await call("DELETE", "/api/webhooks/default")).status, 200);
      assert.deepEqual(fakeDb.webhooks.map((webhook) => webhook.smmApp), ["newlabor"]);
    });
  });

  describe("มีผลกับ /api/line/push ทันที", () => {
    it("smm_app ที่เพิ่มผ่าน API ส่งข้อความได้ทันที และส่งไม่ได้หลังลบ webhook", async () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
      mock.method(globalThis, "fetch", async () => Response.json({}));
      await create(LABOR);
      const push = () => app.request("/api/line/push", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-line-token" },
        body: JSON.stringify({ smm_app: "newlabor", to: "U4af4980629a1b2c3d4e5f60718293a4b", messages: [{ type: "text", text: "hi" }] }),
      });

      assert.equal((await push()).status, 200);
      await call("DELETE", "/api/webhooks/newlabor");
      const afterDelete = await push();
      assert.equal(afterDelete.status, 400);
      assert.equal((await json<{ code: string }>(afterDelete)).code, "UNKNOWN_SMM_APP");

      mock.restoreAll();
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    });
  });
});
