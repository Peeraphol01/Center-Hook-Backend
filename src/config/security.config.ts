// Import Config
import { readPositiveIntegerEnv } from "./env";
// Import Utils
import { parseCidrList, type IpMatcher } from "../utils/ip";

/* -------------------------------------- Config -------------------------------------- */

// Config ค่า default ของการตรวจจับความผิดปกติ
const SECURITY_DEFAULTS = {
  trustProxyHops: 1,
  auditLogRetentionDays: 365,
  bruteForceThreshold: 20,
  bruteForceWindowMinutes: 10,
  alertCooldownMinutes: 10,
} as const;

// Config cache ของ matcher ต่อค่า env (สร้างใหม่เมื่อค่า env เปลี่ยน เช่นใน test)
const matcherCache = new Map<string, IpMatcher | null>();

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านจำนวน proxy ที่เชื่อ X-Forwarded-For (0 = ไม่เชื่อ header ใช้ IP ของ socket อย่างเดียว)
export function getTrustProxyHops(): number {
  const raw = process.env.TRUST_PROXY_HOPS?.trim();

  if (!raw) {
    return SECURITY_DEFAULTS.trustProxyHops;
  }

  const value = Number(raw);

  if (!Number.isInteger(value) || value < 0) {
    throw new Error("TRUST_PROXY_HOPS must be set to a non-negative integer.");
  }

  return value;
}

// Function อ่านรหัสลับที่ frontend (Next proxy) แนบมาใน x-proxy-secret เพื่อยืนยันว่า x-client-ip เชื่อได้ (ไม่ตั้ง = ไม่เชื่อ x-client-ip)
export function getProxySharedSecret(): string | null {
  const value = process.env.PROXY_SHARED_SECRET?.trim();

  if (!value) {
    return null;
  }

  if (value.length < 32) {
    throw new Error("PROXY_SHARED_SECRET must be at least 32 characters.");
  }

  return value;
}

// Function อ่านรายการ CIDR จาก env (ไม่ตั้ง = ไม่จำกัด IP คืน null)
function readCidrEnv(name: "IP_ALLOWLIST_ADMIN" | "IP_ALLOWLIST_LINE_PUSH"): IpMatcher | null {
  const raw = process.env[name]?.trim() ?? "";
  const cacheKey = `${name}=${raw}`;

  if (!matcherCache.has(cacheKey)) {
    matcherCache.set(cacheKey, raw ? parseCidrList(raw, name) : null);
  }

  return matcherCache.get(cacheKey) ?? null;
}

// Function อ่านวง IP ที่เข้าหน้า admin ได้ (/api/auth, /api/admins, /api/dashboard, /api/forward-logs, /api/webhooks, /api/audit-logs, /api-docs)
export function getAdminAllowlist(): IpMatcher | null {
  return readCidrEnv("IP_ALLOWLIST_ADMIN");
}

// Function อ่านวง IP ของ server project ที่เรียก /api/line/push ได้
export function getLinePushAllowlist(): IpMatcher | null {
  return readCidrEnv("IP_ALLOWLIST_LINE_PUSH");
}

// Function อ่านอายุ audit log ก่อนลบอัตโนมัติ (วัน)
export function getAuditLogRetentionDays(): number {
  return readPositiveIntegerEnv("AUDIT_LOG_RETENTION_DAYS", SECURITY_DEFAULTS.auditLogRetentionDays);
}

// Function อ่านเกณฑ์ brute force: login ผิดจาก IP เดียวกันกี่ครั้งภายในกี่นาทีจึงแจ้งเตือน
export function getBruteForceConfig(): { threshold: number; windowMs: number } {
  return {
    threshold: readPositiveIntegerEnv("SECURITY_BRUTE_FORCE_THRESHOLD", SECURITY_DEFAULTS.bruteForceThreshold),
    windowMs: readPositiveIntegerEnv("SECURITY_BRUTE_FORCE_WINDOW_MINUTES", SECURITY_DEFAULTS.bruteForceWindowMinutes) * 60 * 1000,
  };
}

// Function อ่านปลายทางแจ้งเตือนความปลอดภัย (LINE user/group id ไม่ตั้ง = ไม่ส่งแจ้งเตือน) และช่วงเวลาที่ไม่ส่งเรื่องเดิมซ้ำ
export function getSecurityAlertConfig(): { lineTo: string | null; cooldownMs: number } {
  return {
    lineTo: process.env.SECURITY_ALERT_LINE_TO?.trim() || null,
    cooldownMs: readPositiveIntegerEnv("SECURITY_ALERT_COOLDOWN_MINUTES", SECURITY_DEFAULTS.alertCooldownMinutes) * 60 * 1000,
  };
}

// Function ตรวจค่า env ด้านความปลอดภัยตอนเริ่ม server (ตั้งผิดให้ล้มตั้งแต่ start ไม่ใช่ไปพังตอนมี request)
export function validateSecurityConfig(): void {
  getTrustProxyHops();
  getProxySharedSecret();
  getAdminAllowlist();
  getLinePushAllowlist();
  getAuditLogRetentionDays();
  getBruteForceConfig();
  getSecurityAlertConfig();
}
