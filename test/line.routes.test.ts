// Import Library
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

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

// Type แถวของ forward_logs ที่บันทึกลงฐานข้อมูลปลอม (ชื่อ field แบบ Prisma)
type FakeRow = Record<string, unknown> & { id: number; createdAt: Date };

// Config ฐานข้อมูลปลอม: เก็บ log ที่ repository บันทึกไว้ใน memory
const fakeDb = {
  rows: [] as FakeRow[],
  // แถวในตาราง webhooks (ชื่อ field แบบ Prisma)
  webhooks: [] as Record<string, unknown>[],
  // ตั้งเป็น Error เพื่อให้การบันทึกครั้งถัดไปล้มครั้งเดียว
  failNext: null as Error | null,
  reset(): void {
    this.rows = [];
    this.failNext = null;
    this.webhooks = [
      { id: 1, smmApp: "newlabor", webhookUrl: "http://labor.test/api/line/webhook", createdAt: new Date(), updatedAt: new Date() },
      { id: 2, smmApp: null, webhookUrl: "http://other.test/webhook", createdAt: new Date(), updatedAt: new Date() },
    ];
  },
};

class FakePrismaClient {
  webhook = {
    findMany: async () => fakeDb.webhooks,
  };

  forwardLog = {
    create: async ({ data }: { data: Record<string, unknown> }) => {
      if (fakeDb.failNext) {
        const error = fakeDb.failNext;
        fakeDb.failNext = null;
        throw error;
      }
      const row = { ...data, id: fakeDb.rows.length + 1, createdAt: (data.createdAt as Date) ?? new Date() } as FakeRow;
      fakeDb.rows.push(row);
      return row;
    },
  };
}

mock.module(require.resolve("@prisma/client"), { exports: { PrismaClient: FakePrismaClient } });

const LINE_SECRET = "test-line-channel-secret";

// Function เซ็น body แบบ LINE (คำนวณเองใน test ไม่พึ่งโค้ดที่ถูกทดสอบ)
function lineSignature(body: string, secret = LINE_SECRET): string {
  return createHmac("sha256", secret).update(body).digest("base64");
}

// Function รอจนเงื่อนไขเป็นจริง ไม่เกิน timeoutMs
async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitUntil timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const { default: app } = require("../src/app") as typeof import("../src/app");
const { runInBackground, waitForBackgroundTasks } = require("../src/utils/background-tasks") as typeof import("../src/utils/background-tasks");
const { clearWebhookCache } = require("../src/services/webhook.service") as typeof import("../src/services/webhook.service");

/* -------------------------------------- Config -------------------------------------- */

const LABOR_URL = "http://labor.test/api/line/webhook";
const DEFAULT_URL = "http://other.test/webhook";
const LINE_TOKEN = "test-line-token";
const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const REPLY_URL = "https://api.line.me/v2/bot/message/reply";
const RETRY_KEY = "3f6c2a8e-91d4-4b7a-a0e5-6d2c8f1b9e47";
const USER_ID = "U4af4980629a1b2c3d4e5f60718293a4b";
const LABOR_POSTBACK = "smm_app=newlabor&token=k3Jx9QmT2vLp8RwN5yHc0ZbF7dGs4AeU";

// Config body ตัวอย่างที่ Labor ส่งมา /push
const PUSH_BODY = {
  smm_app: "newlabor",
  to: USER_ID,
  retry_key: RETRY_KEY,
  messages: [{ type: "flex", altText: "แจ้งยกเลิกงาน 62411170000158 GV3/98", contents: { type: "bubble" } }],
};

/* -------------------------------------- Test Helpers -------------------------------------- */

type FetchCall = { url: string; headers: Record<string, string>; body: string };

// Function แทน fetch ด้วยตัวที่จดทุกการเรียกและตอบตาม handler
function mockFetch(handler: (call: FetchCall, attempt: number) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit = {}) => {
    const call = { url, headers: (init.headers ?? {}) as Record<string, string>, body: String(init.body ?? "") };
    calls.push(call);
    return handler(call, calls.length);
  });
  return calls;
}

// Function สร้าง event postback / message / follow
const postback = (data: string, extra: Record<string, unknown> = {}) => ({ type: "postback", source: { type: "user", userId: USER_ID }, postback: { data }, ...extra });
const text = (value: string, extra: Record<string, unknown> = {}) => ({ type: "message", source: { type: "user", userId: USER_ID }, message: { type: "text", text: value }, ...extra });

// Function ยิง webhook แบบที่ LINE ส่ง (เซ็น signature ให้ เว้นแต่ส่ง signature มาเอง)
function webhook(body: unknown, signature?: string | null): Promise<Response> {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8" };
  if (signature !== null) headers["x-line-signature"] = signature ?? lineSignature(raw);
  return Promise.resolve(app.request("/api/line/webhook", { method: "POST", headers, body: raw }));
}

// Function ยิง webhook แล้วรอจนบันทึก log ครบตามจำนวน event
async function deliver(events: unknown[]): Promise<FakeRow[]> {
  const response = await webhook({ destination: "Udestination", events });
  assert.equal(response.status, 200);
  await waitForBackgroundTasks(3000);
  return fakeDb.rows;
}

// Function ยิง /api/line/push ด้วย Bearer token เดียวกับ LINE_CHANNEL_ACCESS_TOKEN
function push(body: unknown, token: string | null = LINE_TOKEN): Promise<Response> {
  return Promise.resolve(app.request("/api/line/push", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
}

const codeOf = async (response: Response) => ((await response.json()) as { code: string }).code;

/* -------------------------------------- Webhook (ขากลับ) -------------------------------------- */

describe("POST /api/line/webhook", () => {
  beforeEach(() => {
    fakeDb.reset();
    clearWebhookCache();
    process.env.LINE_CHANNEL_SECRET = LINE_SECRET;
  });

  afterEach(() => mock.restoreAll());

  describe("ตรวจ request จาก LINE", () => {
    it("ไม่มี signature หรือ signature ผิดตอบ 401 และไม่ส่งต่อ", async () => {
      const calls = mockFetch(() => new Response("{}"));
      const body = { destination: "U", events: [text("hi")] };

      const missing = await webhook(body, null);
      assert.equal(missing.status, 401);
      assert.equal(((await missing.json()) as { message: string }).message, "LINE signature is required.");

      const wrong = await webhook(body, lineSignature(JSON.stringify(body), "other-secret"));
      assert.equal(wrong.status, 401);
      assert.equal(((await wrong.json()) as { message: string }).message, "LINE signature is invalid.");

      await waitForBackgroundTasks(1000);
      assert.equal(calls.length, 0);
      assert.equal(fakeDb.rows.length, 0);
    });

    it("signature คนละความยาวก็ตอบ 401 ไม่ใช่ 500", async () => {
      assert.equal((await webhook({ events: [] }, "short")).status, 401);
    });

    it("ไม่ได้ตั้ง LINE_CHANNEL_SECRET ตอบ 503", async () => {
      delete process.env.LINE_CHANNEL_SECRET;
      const response = await webhook({ events: [] });

      assert.equal(response.status, 503);
      assert.equal(await codeOf(response), "LINE_WEBHOOK_NOT_CONFIGURED");
    });

    it("body ที่ไม่ใช่ JSON object ตอบ 400 แม้ signature ถูก", async () => {
      for (const raw of ["not json", "[]", "null"]) {
        const response = await webhook(raw);
        assert.equal(response.status, 400, raw);
        assert.equal(await codeOf(response), "VALIDATION_ERROR", raw);
      }
    });

    it("กด Verify ใน LINE Console (events ว่าง) ตอบ 200 โดยไม่ส่งต่อ", async () => {
      const calls = mockFetch(() => new Response("{}"));
      const response = await webhook({ destination: "U", events: [] });

      assert.deepEqual(await response.json(), { message: "LINE webhook received.", received: 0 });
      await waitForBackgroundTasks(1000);
      assert.equal(calls.length, 0);
    });

    it("events ไม่ใช่ array ถือว่าไม่มี event", async () => {
      const response = await webhook({ destination: "U", events: "oops" });
      assert.equal(((await response.json()) as { received: number }).received, 0);
    });

    it("body เกิน 1MB ตอบ 413", async () => {
      const response = await webhook({ events: [text("x".repeat(1024 * 1024))] });
      assert.equal(response.status, 413);
      assert.equal(await codeOf(response), "PAYLOAD_TOO_LARGE");
    });

    it("ไม่จำกัด rate (LINE ยิงจาก IP ชุดเดียวกัน)", async () => {
      for (let i = 0; i < 10; i += 1) {
        assert.equal((await webhook({ events: [] })).status, 200);
      }
    });
  });

  describe("เลือกปลายทางตาม smm_app", () => {
    it("postback smm_app=newlabor ไป webhook_url ของ project newlabor อยู่ตำแหน่งไหนใน data ก็ได้", async () => {
      const calls = mockFetch(() => new Response("{}"));
      await deliver([postback(LABOR_POSTBACK), postback("token=abc&smm_app=newlabor&score=4")]);

      assert.deepEqual(calls.map((call) => call.url), [LABOR_URL, LABOR_URL]);
      assert.deepEqual(fakeDb.rows.map((row) => row.project), ["newlabor", "newlabor"]);
    });

    it("ไม่มี smm_app, smm_app ว่าง หรือไม่รู้จัก ไป webhook default (smm_app = null)", async () => {
      const calls = mockFetch(() => new Response("{}"));
      await deliver([postback("token=abc"), postback("smm_app=&token=abc"), postback("smm_app=unknown"), postback("smm_app=constructor")]);

      assert.deepEqual(calls.map((call) => call.url), [DEFAULT_URL, DEFAULT_URL, DEFAULT_URL, DEFAULT_URL]);
      assert.ok(fakeDb.rows.every((row) => row.project === "default"));
    });

    it("ข้อความ (รวม \"id\"), สติกเกอร์ และ follow ไป webhook default", async () => {
      const calls = mockFetch(() => new Response("{}"));
      await deliver([text("id"), { type: "message", source: { userId: USER_ID }, message: { type: "sticker" } }, { type: "follow", source: { userId: USER_ID } }]);

      assert.deepEqual(calls.map((call) => call.url), [DEFAULT_URL, DEFAULT_URL, DEFAULT_URL]);
      assert.deepEqual(fakeDb.rows.map((row) => [row.eventType, row.messageType, row.content]), [
        ["message", "text", "id"],
        ["message", "sticker", "[sticker]"],
        ["follow", null, null],
      ]);
    });
  });

  describe("พิมพ์ \"id\" ตอบ LINE user id", () => {
    afterEach(() => {
      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    });

    it("ตอบผ่าน Reply API ด้วยข้อความเดิม บันทึก OUTBOUND reply แล้วยังส่งต่อไป webhook default", async () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = LINE_TOKEN;
      const calls = mockFetch(() => new Response("{}"));
      await deliver([text(" ID ", { replyToken: "reply-token-1" })]);

      assert.deepEqual(calls.map((call) => call.url), [REPLY_URL, DEFAULT_URL]);
      assert.equal(calls[0].headers.authorization, `Bearer ${LINE_TOKEN}`);
      assert.deepEqual(JSON.parse(calls[0].body), { replyToken: "reply-token-1", messages: [{ type: "text", text: `Your user ID: ${USER_ID}` }] });
      assert.deepEqual(fakeDb.rows.map((row) => [row.direction, row.project, row.eventType, row.status, row.content]), [
        ["OUTBOUND", "default", "reply", "SUCCESS", `Your user ID: ${USER_ID}`],
        ["INBOUND", "default", "message", "SUCCESS", " ID "],
      ]);
    });

    it("ตอบไม่สำเร็จบันทึก FAILED แต่ยังส่งต่อ event, ไม่มี token หรือไม่มี replyToken ไม่ตอบ", async () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = LINE_TOKEN;
      const calls = mockFetch((call) => (call.url === REPLY_URL ? new Response("Invalid reply token", { status: 400 }) : new Response("{}")));
      await deliver([text("id", { replyToken: "expired" }), text("id"), text("my id", { replyToken: "r" })]);

      assert.deepEqual(calls.map((call) => call.url), [REPLY_URL, DEFAULT_URL, DEFAULT_URL, DEFAULT_URL]);
      assert.deepEqual([fakeDb.rows[0].eventType, fakeDb.rows[0].status, fakeDb.rows[0].httpStatus], ["reply", "FAILED", 400]);

      delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
      fakeDb.reset();
      mock.restoreAll();
      const withoutToken = mockFetch(() => new Response("{}"));
      await deliver([text("id", { replyToken: "r" })]);
      assert.deepEqual(withoutToken.map((call) => call.url), [DEFAULT_URL]);
    });

    it("เรียก Reply API ไม่ได้ (network error) บันทึก FAILED พร้อมสาเหตุ แล้วยังส่งต่อ", async () => {
      process.env.LINE_CHANNEL_ACCESS_TOKEN = LINE_TOKEN;
      const calls = mockFetch((call) => {
        if (call.url === REPLY_URL) throw new Error("ECONNRESET");
        return new Response("{}");
      });
      await deliver([text("id", { replyToken: "r" })]);

      assert.deepEqual(calls.map((call) => call.url), [REPLY_URL, DEFAULT_URL]);
      assert.deepEqual([fakeDb.rows[0].status, fakeDb.rows[0].errorMessage], ["FAILED", "ECONNRESET"]);
    });
  });

  describe("ส่งต่อและบันทึก log", () => {
    it("ส่งทีละ event เซ็น x-line-signature ใหม่ด้วย secret เดิม และบันทึก log INBOUND", async () => {
      const calls = mockFetch(() => new Response("{\"ok\":true}"));
      const events = [postback(LABOR_POSTBACK, { webhookEventId: "E1" }), text("สวัสดี", { webhookEventId: "E2" })];
      await deliver(events);

      calls.forEach((call, index) => {
        assert.deepEqual(JSON.parse(call.body), { destination: "Udestination", events: [events[index]] });
        assert.equal(call.headers["x-line-signature"], lineSignature(call.body));
        assert.equal(call.headers["user-agent"], "center-hook");
      });

      const [labor, other] = fakeDb.rows;
      assert.deepEqual(
        [labor.direction, labor.project, labor.status, labor.httpStatus, labor.lineUserId, labor.webhookEventId, labor.content, labor.responseBody, labor.attempts],
        ["INBOUND", "newlabor", "SUCCESS", 200, USER_ID, "E1", LABOR_POSTBACK, "{\"ok\":true}", 1]
      );
      assert.deepEqual(labor.payload, events[0]);
      assert.equal(labor.targetUrl, LABOR_URL);
      assert.equal(labor.requestId, other.requestId);
    });

    it("ข้อความยาวเกิน 1,000 ตัวถูกตัดใน log", async () => {
      mockFetch(() => new Response("{}"));
      await deliver([text("ก".repeat(1500))]);

      assert.equal(fakeDb.rows[0].content, `${"ก".repeat(1000)}...`);
    });

    it("ไม่มี webhook default บันทึก SKIPPED โดยไม่ส่ง แต่ smm_app ที่ตรงยังส่งได้", async () => {
      fakeDb.webhooks = fakeDb.webhooks.filter((webhook) => webhook.smmApp !== null);
      const calls = mockFetch(() => new Response("{}"));
      await deliver([text("hi"), postback(LABOR_POSTBACK)]);

      assert.deepEqual(calls.map((call) => call.url), [LABOR_URL]);
      assert.deepEqual([fakeDb.rows[0].project, fakeDb.rows[0].status, fakeDb.rows[0].attempts, fakeDb.rows[0].errorMessage], ["default", "SKIPPED", 0, "No default webhook (smm_app = null) is configured."]);
      assert.equal(fakeDb.rows[1].status, "SUCCESS");
    });

    it("webhook ที่เพิ่มใน DB ใช้ได้ทันทีหลังล้าง cache", async () => {
      fakeDb.webhooks.push({ id: 3, smmApp: "shop", webhookUrl: "http://shop.test/hook", createdAt: new Date(), updatedAt: new Date() });
      clearWebhookCache();
      const calls = mockFetch(() => new Response("{}"));
      await deliver([postback("smm_app=shop&order=1")]);

      assert.deepEqual(calls.map((call) => call.url), ["http://shop.test/hook"]);
      assert.equal(fakeDb.rows[0].project, "shop");
    });

    it("ปลายทางตอบ 5xx หรือ 429 retry แล้วสำเร็จ", async () => {
      const calls = mockFetch((_call, attempt) => new Response("busy", { status: attempt === 1 ? 503 : attempt === 2 ? 429 : 200 }));
      await deliver([text("hi")]);

      assert.equal(calls.length, 3);
      assert.deepEqual([fakeDb.rows[0].status, fakeDb.rows[0].attempts, fakeDb.rows[0].httpStatus], ["SUCCESS", 3, 200]);
    });

    it("ปลายทางตอบ 4xx ไม่ retry บันทึก FAILED", async () => {
      const calls = mockFetch(() => new Response("bad signature", { status: 401 }));
      await deliver([text("hi")]);

      assert.equal(calls.length, 1);
      assert.deepEqual([fakeDb.rows[0].status, fakeDb.rows[0].httpStatus, fakeDb.rows[0].errorMessage, fakeDb.rows[0].responseBody], ["FAILED", 401, "HTTP 401", "bad signature"]);
    });

    it("network error ครบทุกรอบบันทึก FAILED พร้อมสาเหตุ", async () => {
      const calls = mockFetch(() => {
        throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
      });
      await deliver([text("hi")]);

      assert.equal(calls.length, 3);
      assert.deepEqual([fakeDb.rows[0].status, fakeDb.rows[0].attempts, fakeDb.rows[0].errorMessage], ["FAILED", 3, "fetch failed: ECONNREFUSED"]);
    });

    it("timeout บันทึกข้อความ Timeout after ...ms", async () => {
      mockFetch(() => {
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      });
      await deliver([text("hi")]);

      assert.equal(fakeDb.rows[0].errorMessage, "Timeout after 1000ms");
    });

    it("error ที่ไม่ใช่ Error object ก็บันทึกได้", async () => {
      mockFetch(() => {
        throw "boom";
      });
      await deliver([text("hi")]);

      assert.equal(fakeDb.rows[0].errorMessage, "boom");
    });

    it("event หนึ่งบันทึก log ไม่สำเร็จไม่กระทบ event ถัดไป", async () => {
      const calls = mockFetch(() => new Response("{}"));
      fakeDb.failNext = new Error("db down");
      await deliver([text("first"), text("second")]);

      assert.equal(calls.length, 2);
      assert.deepEqual(fakeDb.rows.map((row) => row.content), ["second"]);
    });
  });

  describe("งานเบื้องหลัง (index.ts shutdown)", () => {
    it("waitForBackgroundTasks คืน false เมื่อรอเกินเวลา และ true เมื่อเสร็จ", async () => {
      let release: () => void = () => undefined;
      mockFetch(() => new Promise<Response>((resolve) => {
        release = () => resolve(new Response("{}"));
      }));

      await webhook({ events: [text("slow")] });
      await waitUntil(() => typeof release === "function" && fakeDb.rows.length === 0);
      assert.equal(await waitForBackgroundTasks(20), false);

      release();
      assert.equal(await waitForBackgroundTasks(2000), true);
      assert.equal(fakeDb.rows.length, 1);
    });

    it("งานเบื้องหลังที่ throw ไม่หลุดเป็น unhandled rejection", async () => {
      runInBackground("test-task", async () => {
        throw new Error("task failed");
      });
      assert.equal(await waitForBackgroundTasks(1000), true);
    });
  });
});

/* -------------------------------------- Push (ขาไป) -------------------------------------- */

describe("POST /api/line/push", () => {
  let lineResponse: () => Response;
  let calls: FetchCall[];

  beforeEach(() => {
    fakeDb.reset();
    clearWebhookCache();
    process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";
    lineResponse = () => Response.json({ sentMessages: [{ id: "534215478920386561" }] });
    calls = mockFetch(() => lineResponse());
  });

  afterEach(() => {
    mock.restoreAll();
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
  });

  it("ส่ง {to, messages} ไป LINE ด้วย token ของ center-hook + retry key แล้วบันทึก log OUTBOUND", async () => {
    const response = await push(PUSH_BODY);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { sentMessages: [{ id: "534215478920386561" }] });
    assert.equal(calls[0].url, PUSH_URL);
    assert.equal(calls[0].headers.authorization, "Bearer test-line-token");
    assert.equal(calls[0].headers["x-line-retry-key"], RETRY_KEY);
    assert.deepEqual(JSON.parse(calls[0].body), { to: USER_ID, messages: PUSH_BODY.messages });

    const [log] = fakeDb.rows;
    assert.deepEqual(
      [log.direction, log.project, log.status, log.lineUserId, log.eventType, log.messageType, log.content, log.targetUrl, log.attempts],
      ["OUTBOUND", "newlabor", "SUCCESS", USER_ID, "push", "flex", "แจ้งยกเลิกงาน 62411170000158 GV3/98", PUSH_URL, 1]
    );
    assert.deepEqual(log.payload, { to: USER_ID, messages: PUSH_BODY.messages });
  });

  it("ไม่มี retry_key ไม่ส่ง header X-Line-Retry-Key และสรุปหลายข้อความใน log", async () => {
    const { retry_key: _retryKey, ...body } = PUSH_BODY;
    await push({ ...body, messages: [{ type: "text", text: "สวัสดี" }, { type: "image", originalContentUrl: "https://x" }] });

    assert.equal(calls[0].headers["x-line-retry-key"], undefined);
    assert.equal(fakeDb.rows[0].content, "สวัสดี | [image]");
  });

  it("ส่ง status และ body ของ LINE กลับตามจริง (429 โควต้าหมด) และบันทึก FAILED", async () => {
    lineResponse = () => Response.json({ message: "You have reached your monthly limit." }, { status: 429 });
    const response = await push(PUSH_BODY);

    assert.equal(response.status, 429);
    assert.equal(((await response.json()) as { message: string }).message, "You have reached your monthly limit.");
    assert.deepEqual([fakeDb.rows[0].status, fakeDb.rows[0].httpStatus, fakeDb.rows[0].errorMessage], ["FAILED", 429, "HTTP 429"]);
  });

  it("409 พร้อม retry_key = LINE รับไปแล้วจากรอบก่อน บันทึก SUCCESS / ไม่มี retry_key บันทึก FAILED", async () => {
    lineResponse = () => Response.json({ message: "The retry key is already accepted" }, { status: 409 });
    const { retry_key: _retryKey, ...withoutKey } = PUSH_BODY;

    assert.equal((await push(PUSH_BODY)).status, 409);
    assert.equal((await push(withoutKey)).status, 409);
    assert.deepEqual(fakeDb.rows.map((row) => row.status), ["SUCCESS", "FAILED"]);
  });

  it("LINE ตอบ body ที่ไม่ใช่ JSON ส่งกลับเป็น { message }", async () => {
    lineResponse = () => new Response("Bad Gateway", { status: 502 });
    const response = await push(PUSH_BODY);

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { message: "Bad Gateway" });
  });

  it("LINE ไม่ตอบ (network error / timeout) ตอบ 502 ให้ project retry และบันทึก FAILED", async () => {
    mock.restoreAll();
    mockFetch(() => {
      throw new Error("getaddrinfo ENOTFOUND api.line.me");
    });
    const network = await push(PUSH_BODY);
    assert.equal(network.status, 502);
    assert.equal(await codeOf(network), "LINE_API_UNAVAILABLE");

    mock.restoreAll();
    mockFetch(() => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    assert.equal((await push(PUSH_BODY)).status, 502);

    mock.restoreAll();
    mockFetch(() => {
      throw "boom";
    });
    assert.equal((await push(PUSH_BODY)).status, 502);

    assert.deepEqual(fakeDb.rows.map((row) => [row.status, row.errorMessage]), [
      ["FAILED", "getaddrinfo ENOTFOUND api.line.me"],
      ["FAILED", "Timeout after 10000ms"],
      ["FAILED", "boom"],
    ]);
  });

  it("บันทึก log ไม่สำเร็จยังส่งผลของ LINE กลับตามปกติ", async () => {
    fakeDb.failNext = new Error("db down");
    const response = await push(PUSH_BODY);

    assert.equal(response.status, 200);
    assert.equal(fakeDb.rows.length, 0);
  });

  it("ไม่มี Bearer token, token ผิด หรือ header ผิดรูปแบบ ตอบ 401 และไม่ส่ง LINE", async () => {
    assert.equal(await codeOf(await push(PUSH_BODY, null)), "INVALID_ACCESS_TOKEN");
    assert.equal((await push(PUSH_BODY, "wrong-token")).status, 401);

    const basic = await app.request("/api/line/push", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Basic ${LINE_TOKEN}` },
      body: JSON.stringify(PUSH_BODY),
    });
    assert.equal(basic.status, 401);
    assert.equal(calls.length, 0);
  });

  it("smm_app ที่ไม่มีในตาราง webhooks ตอบ 400 UNKNOWN_SMM_APP และไม่ส่ง LINE", async () => {
    const response = await push({ ...PUSH_BODY, smm_app: "otherapp" });

    assert.equal(response.status, 400);
    assert.equal(await codeOf(response), "UNKNOWN_SMM_APP");
    assert.equal(calls.length, 0);
  });

  it("body ผิดรูปแบบหรือไม่ใช่ JSON ตอบ 400 พร้อมรายละเอียด", async () => {
    const invalid = await push({ ...PUSH_BODY, messages: [] });
    const body = (await invalid.json()) as { code: string; validation_errors: { field: string }[] };

    assert.equal(invalid.status, 400);
    assert.equal(body.code, "VALIDATION_ERROR");
    assert.equal(body.validation_errors[0].field, "messages");
    assert.equal((await push({ ...PUSH_BODY, retry_key: "not-a-uuid" })).status, 400);
    assert.equal((await push("{not json")).status, 400);
    assert.equal(calls.length, 0);
  });

  it("ไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN ตอบ 503", async () => {
    delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
    const response = await push(PUSH_BODY);

    assert.equal(response.status, 503);
    assert.equal(await codeOf(response), "LINE_PUSH_NOT_CONFIGURED");
  });
});
