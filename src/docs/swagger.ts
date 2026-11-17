// Import Library
import fs from "node:fs";
import path from "node:path";
import type { Hono } from "hono";
import { basicAuth } from "hono/basic-auth";
import { getAbsoluteFSPath } from "swagger-ui-dist";
import { parse as parseYaml } from "yaml";
// Import Types
import type { AppContext, AppEnv } from "../types/app.types";

/* -------------------------------------- Types -------------------------------------- */

// Type ส่วนของ OpenAPI ที่แต่ละไฟล์ YAML ประกาศ (paths และ/หรือ components)
type OpenApiFragment = {
  paths?: Record<string, unknown>;
  components?: Record<string, Record<string, unknown>>;
};

/* -------------------------------------- Config -------------------------------------- */

// Config ไฟล์ YAML ของ OpenAPI (อ่านจากโฟลเดอร์ข้างไฟล์นี้ ไม่ขึ้นกับ cwd)
const OPENAPI_FILES = ["system.yaml", "auth.yaml", "admins.yaml", "line.yaml", "forward-logs.yaml", "webhooks.yaml", "components.yaml"];

// Config ส่วนหัวของ OpenAPI spec
const OPENAPI_INFO = {
  title: "Center Hook API",
  version: "1.0.0",
  description:
    "รับ LINE webhook แล้วส่งต่อไป project ปลายทาง พร้อมเก็บ forward log | Path ที่มี / ท้ายใช้ได้เหมือนกัน | Body ทุกชนิดไม่เกิน 1MB: เกินตอบ 413 PAYLOAD_TOO_LARGE, JSON ผิดรูปแบบตอบ 400 VALIDATION_ERROR | ส่ง X-Request-Id มาเองได้ (A-Z a-z 0-9 _ - = ไม่เกิน 255 ตัว) ถ้าไม่ส่งหรือรูปแบบผิดระบบสร้าง UUID ให้ และส่งกลับใน response header X-Request-Id กับ request_id ของ error",
};

// Config ไฟล์ของ Swagger UI ที่เสิร์ฟจาก package ในเครื่อง (ไม่พึ่ง CDN)
const SWAGGER_ASSET_TYPES: Record<string, string> = {
  "swagger-ui.css": "text/css; charset=utf-8",
  "swagger-ui-bundle.js": "text/javascript; charset=utf-8",
  "swagger-ui-standalone-preset.js": "text/javascript; charset=utf-8",
  "favicon-32x32.png": "image/png",
};

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านไฟล์ YAML ทุกไฟล์แล้วรวมเป็น spec เดียว (path หรือ component ชื่อซ้ำข้ามไฟล์ให้ throw ตอนเริ่ม server)
function buildOpenApiSpec(): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  const components: Record<string, Record<string, unknown>> = {};

  // Function ย้าย entry เข้า target โดยห้ามชื่อซ้ำ
  const mergeEntries = (target: Record<string, unknown>, source: Record<string, unknown>, label: string, file: string) => {
    for (const [key, value] of Object.entries(source)) {
      if (key in target) {
        throw new Error(`Duplicate OpenAPI ${label} "${key}" in ${file}.`);
      }
      target[key] = value;
    }
  };

  for (const file of OPENAPI_FILES) {
    const fragment = (parseYaml(fs.readFileSync(path.join(__dirname, "openapi", file), "utf8")) ?? {}) as OpenApiFragment;

    mergeEntries(paths, fragment.paths ?? {}, "path", file);

    for (const [section, entries] of Object.entries(fragment.components ?? {})) {
      mergeEntries((components[section] ??= {}), entries, `components.${section}`, file);
    }
  }

  return { openapi: "3.0.0", info: OPENAPI_INFO, paths, components };
}

// Config OpenAPI spec ที่อ่านจากไฟล์ YAML (สร้างครั้งเดียวตอนโหลด module)
const openapi = buildOpenApiSpec();

// Function สร้างหน้า HTML ของ Swagger UI
function buildSwaggerPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Center Hook API Docs</title>
<link rel="icon" href="/api-docs/favicon-32x32.png">
<link rel="stylesheet" href="/api-docs/swagger-ui.css">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/api-docs/swagger-ui-bundle.js"></script>
<script src="/api-docs/swagger-ui-standalone-preset.js"></script>
<script>
window.ui = SwaggerUIBundle({
  url: "/api-docs/openapi.json",
  dom_id: "#swagger-ui",
  presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
  layout: "StandaloneLayout",
  persistAuthorization: true,
});
</script>
</body>
</html>`;
}

// Function ตอบไฟล์ของ Swagger UI จาก package (ชื่อไฟล์ต้องอยู่ในรายการที่อนุญาต)
function sendSwaggerAsset(c: AppContext): Response {
  const fileName = c.req.param("asset") ?? "";
  const contentType = SWAGGER_ASSET_TYPES[fileName];

  if (!contentType) {
    return c.notFound() as Response;
  }

  const content = fs.readFileSync(path.join(getAbsoluteFSPath(), fileName));

  return c.body(new Uint8Array(content), 200, { "Content-Type": contentType });
}

// Function ตั้งค่า route ของ Swagger UI และ spec JSON (แบบเดียวกับ Labor-Project-Backend)
// ตั้ง API_DOCS_USERNAME/API_DOCS_PASSWORD = บังคับ Basic auth, ไม่ตั้งใน production = ปิด docs, ไม่ตั้งใน dev = เปิดโล่ง
// รหัสนี้ใช้เปิดหน้า docs อย่างเดียว ยิง API ที่ต้อง login จาก Swagger ใช้ปุ่ม Authorize ใส่ access token
export default function setupSwagger(app: Hono<AppEnv>): void {
  const username = process.env.API_DOCS_USERNAME?.trim();
  const password = process.env.API_DOCS_PASSWORD;

  if (username && password) {
    // basicAuth เทียบรหัสแบบ timing-safe และส่ง WWW-Authenticate ให้เอง
    const docsAuth = basicAuth({
      username,
      password,
      realm: "Center Hook API Docs",
      invalidUserMessage: (c: AppContext) => ({
        status_code: 401,
        code: "API_DOCS_AUTH_REQUIRED",
        message: "API docs credentials are required.",
        request_id: c.get("requestId"),
      }),
    });

    app.use("/api-docs", docsAuth);
    app.use("/api-docs/*", docsAuth);
  } else if (process.env.NODE_ENV === "production") {
    return;
  }

  app.get("/api-docs/openapi.json", (c) => c.json(openapi as object));
  app.get("/api-docs", (c) => c.html(buildSwaggerPage()));
  app.get("/api-docs/:asset", sendSwaggerAsset);
}
