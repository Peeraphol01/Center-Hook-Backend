// Import Library
import { contextStorage } from "hono/context-storage";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
// Import Docs
import setupSwagger from "./docs/swagger";
// Import Middlewares
import { bodyLimitMiddleware, jsonBodyMiddleware } from "./middlewares/body.middleware";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { ipAllowlistMiddleware } from "./middlewares/ip-allowlist.middleware";
import { loginRateLimitMiddleware, rateLimitMiddleware } from "./middlewares/rate-limit.middleware";
import { requestLoggerMiddleware } from "./middlewares/request-logger.middleware";
// Import Routes
import adminRoutes from "./routes/admin.routes";
import auditRoutes from "./routes/audit.routes";
import authRoutes from "./routes/auth.routes";
import dashboardRoutes from "./routes/dashboard.routes";
import healthRoutes from "./routes/health.routes";
import lineRoutes from "./routes/line.routes";
import logRoutes from "./routes/log.routes";
import webhookRoutes from "./routes/webhook.routes";
// Import Utils
import { createRouter } from "./utils/api-helper";

/* -------------------------------------- App -------------------------------------- */

// Config Hono app
const app = createRouter();

// Config CORS origin จาก env (คั่นหลาย origin ด้วย comma ไม่ตั้ง = ไม่เปิด CORS)
const corsOrigins = (process.env.CORS_ORIGIN ?? "").split(",").map((origin) => origin.trim()).filter(Boolean);

app.use(requestId());
// เก็บ context ของ request ให้ audit log อ่าน IP / ผู้ login ได้โดยไม่ต้องส่งต่อทุกชั้น
app.use(contextStorage());
app.use(requestLoggerMiddleware);
app.use(secureHeaders());
// จำกัด IP ก่อนทำอย่างอื่น (IP_ALLOWLIST_ADMIN / IP_ALLOWLIST_LINE_PUSH ไม่ตั้ง = ไม่จำกัด)
app.use(ipAllowlistMiddleware);

if (corsOrigins.length > 0) {
  app.use(cors({ origin: corsOrigins.includes("*") ? "*" : corsOrigins }));
}

app.use(bodyLimitMiddleware);
app.use(jsonBodyMiddleware);
app.use(rateLimitMiddleware);
app.use(loginRateLimitMiddleware);

/* -------------------------------------- Routes -------------------------------------- */

app.route("/", healthRoutes);
// login ของผู้ดูแล (JWT) และจัดการบัญชีผู้ดูแล + สิทธิ์
app.route("/api/auth", authRoutes);
app.route("/api/admins", adminRoutes);
// webhook (ขากลับ LINE → project) และ push (ขาไป project → LINE)
app.route("/api/line", lineRoutes);
app.route("/api/forward-logs", logRoutes);
app.route("/api/webhooks", webhookRoutes);
// สรุปข้อมูลหน้า Dashboard
app.route("/api/dashboard", dashboardRoutes);
// ประวัติการใช้งาน (audit log) และสรุปความผิดปกติ
app.route("/api/audit-logs", auditRoutes);

// Config Swagger UI ที่ /api-docs
setupSwagger(app);

app.notFound(notFoundHandler);
app.onError(errorHandler);

export default app;
