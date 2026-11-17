// Import Library
import { isIPv6 } from "node:net";
import { MemoryStore, rateLimiter } from "hono-rate-limiter";
// Import Config
import { readPositiveIntegerEnv } from "../config/env";
// Import Types
import type { AppContext, AppEnv } from "../types/app.types";
// Import Utils
import { ApiError, getClientIp } from "../utils/api-helper";

/* -------------------------------------- Config -------------------------------------- */

// Config กลุ่ม route ที่แยก bucket rate limit (ไม่จำกัด /api/line/webhook เพราะ LINE ยิงมาจาก IP ชุดเดียวกันทั้งหมด)
const RATE_LIMITED_ROUTE_GROUPS = [
  { group: "auth", pattern: /^\/api\/auth(\/|$)/ },
  { group: "admins", pattern: /^\/api\/admins(\/|$)/ },
  { group: "forward-logs", pattern: /^\/api\/forward-logs(\/|$)/ },
  { group: "webhooks", pattern: /^\/api\/webhooks(\/|$)/ },
  { group: "audit-logs", pattern: /^\/api\/audit-logs(\/|$)/ },
  { group: "docs", pattern: /^\/api-docs/ },
] as const;

// Config ช่วงเวลาและเพดานของ rate limit (login มีเพดานแยกที่ต่ำกว่า กันเดารหัสผ่าน)
const RATE_LIMIT = {
  windowMs: readPositiveIntegerEnv("RATE_LIMIT_WINDOW_MS", 60_000),
  maxRequests: readPositiveIntegerEnv("RATE_LIMIT_MAX_REQUESTS", 300),
  loginMaxRequests: readPositiveIntegerEnv("LOGIN_RATE_LIMIT_MAX_REQUESTS", 10),
};

// Config store ของตัวนับ (เก็บใน memory ของ process ถ้ารันหลาย instance เปลี่ยนเป็น RedisStore ได้)
const routeGroupStore = new MemoryStore<AppEnv>();
const loginStore = new MemoryStore<AppEnv>();

// Config path ของ login ที่ใช้เพดานแยก
const LOGIN_PATH_PATTERN = /^\/api\/auth\/login\/?$/;

/* -------------------------------------- Functions -------------------------------------- */

// Function ขยาย IPv6 เป็น 8 กลุ่มเต็ม
function expandIpv6(ip: string): string[] {
  const [head, tail = ""] = ip.split("%")[0].split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const zeros = Array<string>(Math.max(8 - headGroups.length - tailGroups.length, 0)).fill("0");

  return [...headGroups, ...zeros, ...tailGroups];
}

// Function แปลง IP เป็น key ของ rate limit (IPv6 รวมเป็น subnet /56 กันสลับ address หลบเพดาน)
export function toRateLimitIpKey(ip: string): string {
  if (!isIPv6(ip) || ip.includes(".")) {
    return ip.replace(/^::ffff:/i, "");
  }

  const groups = expandIpv6(ip).slice(0, 4).map((group) => group.padStart(4, "0"));

  return `${groups.slice(0, 3).join(":")}:${groups[3].slice(0, 2)}00::/56`;
}

// Function หากลุ่ม route ของ request (ไม่อยู่ในกลุ่มใดคืน undefined = ไม่จำกัด)
function findRouteGroup(c: AppContext): string | undefined {
  return RATE_LIMITED_ROUTE_GROUPS.find(({ pattern }) => pattern.test(c.req.path))?.group;
}

// Function หา key ของ bucket: นับต่อ IP แยกตามกลุ่ม route
function getRateLimitKey(c: AppContext): string {
  return `${findRouteGroup(c)}:${toRateLimitIpKey(getClientIp(c) || "unknown")}`;
}

// Function ตอบ 429 ผ่าน error handler กลาง (header RateLimit-* / Retry-After ที่ตั้งไว้แล้วติดไปกับ response)
function throwRateLimited(): never {
  throw new ApiError(429, "RATE_LIMITED", "Too many requests.");
}

// Config middleware จำกัดจำนวน request ต่อ client ตามกลุ่ม route (ตั้ง header RateLimit-* ทุก response และ Retry-After ตอนเกินเพดาน)
export const rateLimitMiddleware = rateLimiter<AppEnv>({
  windowMs: RATE_LIMIT.windowMs,
  limit: RATE_LIMIT.maxRequests,
  standardHeaders: "draft-6",
  store: routeGroupStore,
  skip: (c) => !findRouteGroup(c),
  keyGenerator: getRateLimitKey,
  handler: throwRateLimited,
});

// Config middleware จำกัดจำนวนครั้ง login ต่อ IP (นับเฉพาะ POST /api/auth/login รวมแบบมี / ท้าย)
export const loginRateLimitMiddleware = rateLimiter<AppEnv>({
  windowMs: RATE_LIMIT.windowMs,
  limit: RATE_LIMIT.loginMaxRequests,
  standardHeaders: "draft-6",
  store: loginStore,
  skip: (c) => c.req.method !== "POST" || !LOGIN_PATH_PATTERN.test(c.req.path),
  keyGenerator: (c) => `login:${toRateLimitIpKey(getClientIp(c) || "unknown")}`,
  handler: throwRateLimited,
});

// Function ลบตัวนับทั้งหมด (ใช้ใน test)
export function clearRateLimitBuckets(): void {
  routeGroupStore.resetAll();
  loginStore.resetAll();
}
