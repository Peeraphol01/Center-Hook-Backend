// Import Library
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

/* -------------------------------------- Setup -------------------------------------- */

// ตั้ง env ก่อนโหลด module (ไม่ตั้ง SENTRY_DSN = ไม่โหลด Sentry ทดสอบเฉพาะการแจ้งเตือน LINE)
Object.assign(process.env, {
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgresql://test:test@localhost:5432/center_hook_test",
  LINE_CHANNEL_ACCESS_TOKEN: "test-line-access-token",
  SECURITY_ALERT_LINE_TO: "U-security",
});
delete process.env.SENTRY_DSN;

const { Hono } = require("hono") as typeof import("hono");
const { contextStorage } = require("hono/context-storage") as typeof import("hono/context-storage");
const { requestId } = require("hono/request-id") as typeof import("hono/request-id");
const { errorHandler } = require("../src/middlewares/error.middleware") as typeof import("../src/middlewares/error.middleware");
const { reportError, trackForwardResult, resetErrorReportState } = require("../src/services/error-report.service") as typeof import("../src/services/error-report.service");
const { resetSecurityAlertState } = require("../src/services/security-alert.service") as typeof import("../src/services/security-alert.service");
const { ApiError } = require("../src/utils/api-helper") as typeof import("../src/utils/api-helper");

// Config ข้อความที่ส่งเข้า LINE push API
let pushed: { to: string; text: string }[] = [];

// Function รอให้งานส่ง LINE ที่ไม่ได้ await (void) ทำงานเสร็จ
const flush = () => new Promise((resolve) => setImmediate(resolve));

beforeEach(() => {
  pushed = [];
  resetErrorReportState();
  resetSecurityAlertState();
  mock.method(globalThis, "fetch", async (_url: string, init: RequestInit = {}) => {
    const body = JSON.parse(String(init.body)) as { to: string; messages: { text: string }[] };
    pushed.push({ to: body.to, text: body.messages[0].text });
    return new Response("{}", { status: 200 });
  });
});

afterEach(() => {
  mock.restoreAll();
  process.env.SECURITY_ALERT_LINE_TO = "U-security";
});

/* -------------------------------------- Tests -------------------------------------- */

describe("reportError", () => {
  it("ส่งข้อความเข้า LINE พร้อมที่มาและข้อความ error", async () => {
    await reportError(new TypeError("boom"), { source: "background:test" });

    assert.equal(pushed.length, 1);
    assert.equal(pushed[0].to, "U-security");
    assert.match(pushed[0].text, /System error/);
    assert.match(pushed[0].text, /source: background:test/);
    assert.match(pushed[0].text, /error: TypeError: boom/);
  });

  it("error เดิมไม่ส่งซ้ำในช่วง cooldown แต่ error อื่นยังส่ง", async () => {
    await reportError(new Error("same"), { source: "http" });
    await reportError(new Error("same"), { source: "http" });
    await reportError(new Error("other"), { source: "http" });

    assert.deepEqual(pushed.map((p) => /error: (.*)/.exec(p.text)?.[1]), ["Error: same", "Error: other"]);
  });

  it("ไม่ตั้งปลายทางเลย = ไม่ส่ง LINE และไม่ throw", async () => {
    delete process.env.SECURITY_ALERT_LINE_TO;
    await reportError("plain string error", { source: "http" });

    assert.equal(pushed.length, 0);
  });

  it("LINE ตอบ error ก็ไม่ throw", async () => {
    mock.restoreAll();
    mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });

    await assert.doesNotReject(reportError(new Error("x"), { source: "http" }));
  });
});

describe("errorHandler", () => {
  // Function สร้าง app เล็กๆ ที่ใช้ errorHandler จริง
  function buildApp() {
    const app = new Hono();
    app.use(requestId());
    app.use(contextStorage());
    app.get("/crash", () => {
      throw new Error("database is down");
    });
    app.get("/not-found", () => {
      throw new ApiError(404, "NOT_FOUND", "nope");
    });
    app.onError(errorHandler as never);
    return app;
  }

  it("500 ตอบ client แบบซ่อนรายละเอียด และแจ้งเตือนพร้อม method / path / request_id", async () => {
    const response = await buildApp().request("/crash");
    const body = (await response.json()) as { code: string; message: string; request_id: string };
    await flush();

    assert.equal(response.status, 500);
    assert.equal(body.code, "INTERNAL_SERVER_ERROR");
    assert.doesNotMatch(body.message, /database/);
    assert.equal(pushed.length, 1);
    assert.match(pushed[0].text, /source: http \(GET \/crash\)/);
    assert.match(pushed[0].text, /database is down/);
    assert.ok(pushed[0].text.includes(`request_id: ${body.request_id}`));
  });

  it("error 4xx ไม่แจ้งเตือน", async () => {
    const response = await buildApp().request("/not-found");
    await flush();

    assert.equal(response.status, 404);
    assert.equal(pushed.length, 0);
  });
});

describe("trackForwardResult", () => {
  const failed = { status: "FAILED" as const, http_status: 502, error_message: "HTTP 502" };
  const success = { status: "SUCCESS" as const, http_status: 200, error_message: null };

  it("ล้มเหลวติดกันถึงเกณฑ์แจ้งเตือนครั้งเดียว แล้วแจ้งอีกครั้งเมื่อกลับมาส่งได้", async () => {
    for (let i = 0; i < 7; i += 1) trackForwardResult("shop", "https://shop.test/hook", failed);
    await flush();

    assert.equal(pushed.length, 1);
    assert.match(pushed[0].text, /Forward failing/);
    assert.match(pushed[0].text, /project: shop/);
    assert.match(pushed[0].text, /failed: 5 times in a row/);
    assert.match(pushed[0].text, /last error: HTTP 502/);

    trackForwardResult("shop", "https://shop.test/hook", success);
    await flush();

    assert.equal(pushed.length, 2);
    assert.match(pushed[1].text, /Forward recovered/);
  });

  it("สำเร็จคั่นกลางนับใหม่ และ SKIPPED ไม่นับ", async () => {
    const send = (result: typeof failed | typeof success, times: number) => {
      for (let i = 0; i < times; i += 1) trackForwardResult("shop", "https://shop.test/hook", result);
    };
    send(failed, 4);
    send(success, 1);
    send(failed, 4);
    trackForwardResult("shop", null, { status: "SKIPPED", http_status: null, error_message: "No default webhook" });
    await flush();

    assert.equal(pushed.length, 0);

    send(failed, 1);
    await flush();

    assert.equal(pushed.length, 1);
  });

  it("นับแยกต่อ project", async () => {
    for (let i = 0; i < 4; i += 1) {
      trackForwardResult("a", "https://a.test", failed);
      trackForwardResult("b", "https://b.test", failed);
    }
    await flush();

    assert.equal(pushed.length, 0);

    trackForwardResult("a", "https://a.test", failed);
    await flush();

    assert.equal(pushed.length, 1);
    assert.match(pushed[0].text, /project: a/);
  });
});
