// Import Library
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* -------------------------------------- Setup -------------------------------------- */

process.env.LOG_LEVEL = "silent";

const { default: setupSwagger } = require("../src/docs/swagger") as typeof import("../src/docs/swagger");
const { createRouter } = require("../src/utils/api-helper") as typeof import("../src/utils/api-helper");

// Function ตั้ง env ชั่วคราว (undefined = ลบ) แล้วคืนฟังก์ชันคืนค่าเดิม
function withEnv(env: Record<string, string | undefined>): () => void {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  apply(env);
  return () => apply(previous);
}

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้าง app ที่มีแค่ Swagger ตาม env (Swagger อ่าน env ตอนประกอบ route)
function docsApp(env: Record<string, string | undefined>) {
  const restore = withEnv(env);
  const app = createRouter();

  setupSwagger(app);
  restore();
  return app;
}

/* -------------------------------------- Tests -------------------------------------- */

const DEV = { NODE_ENV: "development", API_DOCS_USERNAME: undefined, API_DOCS_PASSWORD: undefined };

// Function สร้าง header Basic auth
function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("GET /api-docs", () => {
  it("ตั้ง API_DOCS_USERNAME/API_DOCS_PASSWORD แล้วต้องใส่ Basic auth ทุกไฟล์ของ docs", async () => {
    const app = docsApp({ NODE_ENV: "production", API_DOCS_USERNAME: "docs", API_DOCS_PASSWORD: "s3cret" });

    for (const path of ["/api-docs", "/api-docs/openapi.json", "/api-docs/swagger-ui.css"]) {
      const missing = await app.request(path);
      assert.equal(missing.status, 401, path);
      assert.ok(missing.headers.get("www-authenticate"), path);
      assert.equal(((await missing.json()) as { code: string }).code, "API_DOCS_AUTH_REQUIRED", path);
      assert.equal((await app.request(path, { headers: { authorization: basic("docs", "wrong") } })).status, 401, path);
      assert.equal((await app.request(path, { headers: { authorization: basic("wrong", "s3cret") } })).status, 401, path);
      assert.equal((await app.request(path, { headers: { authorization: basic("docs", "s3cret") } })).status, 200, path);
    }
  });

  it("ไม่ตั้งรหัสใน production = ปิด docs (404)", async () => {
    assert.equal((await docsApp({ ...DEV, NODE_ENV: "production" }).request("/api-docs/openapi.json")).status, 404);
  });

  it("ไม่ตั้งรหัสตอน dev = เปิดโล่ง", async () => {
    assert.equal((await docsApp(DEV).request("/api-docs/openapi.json")).status, 200);
  });

  it("หน้า Swagger UI โหลดไฟล์จากเครื่อง ไม่ใช้ CDN และไฟล์ที่ไม่อยู่ในรายการตอบ 404", async () => {
    const app = docsApp(DEV);
    const html = await (await app.request("/api-docs")).text();

    assert.match(html, /\/api-docs\/swagger-ui-bundle\.js/);
    assert.doesNotMatch(html, /https?:\/\/(cdn|unpkg)/);
    assert.equal((await app.request("/api-docs/swagger-ui-bundle.js")).headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal((await app.request("/api-docs/package.json")).status, 404);
  });

  it("ทุก $ref ใน spec ชี้ไปที่ component ที่มีอยู่จริง", async () => {
    const app = docsApp(DEV);
    const spec = (await (await app.request("/api-docs/openapi.json")).json()) as { components: Record<string, Record<string, unknown>> };
    const refs = [...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/(\w+)\/(\w+)"/g)].map(([, section, name]) => `${section}/${name}`);

    assert.ok(refs.length > 0);
    assert.deepEqual(refs.filter((ref) => {
      const [section, name] = ref.split("/");
      return !spec.components[section]?.[name];
    }), []);
  });

  it("ทุก route ที่ต้อง login ประกาศ bearerAuth และไม่เหลือ basicAuth", async () => {
    const spec = (await (await docsApp(DEV).request("/api-docs/openapi.json")).json()) as {
      paths: Record<string, Record<string, { security?: Record<string, unknown>[] }>>;
      components: { securitySchemes: Record<string, unknown> };
    };

    assert.ok(spec.components.securitySchemes.bearerAuth);
    assert.equal(spec.components.securitySchemes.basicAuth, undefined);

    for (const path of Object.keys(spec.paths).filter((item) => /^\/api\/(admins|forward-logs|webhooks)|^\/api\/auth\/(me|logout)/.test(item))) {
      for (const [method, operation] of Object.entries(spec.paths[path])) {
        assert.ok(operation.security?.some((item) => "bearerAuth" in item), `${method.toUpperCase()} ${path}`);
      }
    }
  });

  it("spec มีครบทุก route ของระบบ", async () => {
    const app = docsApp(DEV);
    const spec = (await (await app.request("/api-docs/openapi.json")).json()) as { paths: Record<string, unknown> };

    assert.deepEqual(Object.keys(spec.paths).sort(), ["/", "/api/admins", "/api/admins/{id}", "/api/admins/{id}/password", "/api/admins/{id}/unlock","/api/auth/login", "/api/auth/logout", "/api/auth/me", "/api/auth/me/password", "/api/auth/refresh", "/api/forward-logs", "/api/forward-logs/{id}", "/api/line/push", "/api/line/webhook", "/api/webhooks", "/api/webhooks/{smm_app}"]);
  });
});
