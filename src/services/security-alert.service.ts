// Import Config
import { LINE_API_CONFIG } from "../config/app.config";
import { readOptionalEnv } from "../config/env";
import { getBruteForceConfig, getSecurityAlertConfig } from "../config/security.config";
// Import Types
import type { AuditLogCreateInput } from "../types/audit.types";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config จำนวน key สูงสุดที่เก็บใน memory ก่อนล้างรายการที่หมดอายุ (กันโดนยิงจากหลาย IP จน memory โต)
const MAX_TRACKED_KEYS = 10_000;

// Config ตัวนับ login ผิดต่อ IP (นับใน memory ของ process ถ้ารันหลาย instance แต่ละตัวนับแยกกัน)
const failedLoginsByIp = new Map<string, { count: number; windowStart: number }>();

// Config เวลาที่ส่งแจ้งเตือนเรื่องเดียวกันได้อีกครั้ง
const alertCooldowns = new Map<string, number>();

// Config ความยาวข้อความสูงสุดที่ LINE รับ (text message 5,000 ตัวอักษร)
const LINE_TEXT_MAX_LENGTH = 5000;

/* -------------------------------------- Helpers -------------------------------------- */

// Function ล้าง key ที่หมดอายุเมื่อ map ใหญ่เกิน
function pruneExpired<T>(map: Map<string, T>, isExpired: (value: T) => boolean): void {
  if (map.size < MAX_TRACKED_KEYS) {
    return;
  }

  for (const [key, value] of map) {
    if (isExpired(value)) {
      map.delete(key);
    }
  }

  // ทุกตัวยังไม่หมดอายุ = ลบตัวเก่าสุดครึ่งหนึ่ง (Map เรียงตามลำดับที่ใส่)
  if (map.size >= MAX_TRACKED_KEYS) {
    [...map.keys()].slice(0, Math.floor(map.size / 2)).forEach((key) => map.delete(key));
  }
}

// Function แปลงเวลาเป็นเวลาไทยสำหรับข้อความแจ้งเตือน
export function formatBangkokTime(date: Date): string {
  return date.toLocaleString("th-TH", { timeZone: "Asia/Bangkok", hour12: false });
}

// Function สร้างข้อความแจ้งเตือน
function buildAlertText(log: AuditLogCreateInput): string {
  const lines = [
    "[center-hook] Security alert",
    `event: ${log.action} (${log.result})`,
    `user: ${log.actor_username ?? "-"}${log.actor_account_id ? ` #${log.actor_account_id}` : ""}`,
    `ip: ${log.ip_address ?? "-"}`,
    `time: ${formatBangkokTime(new Date())}`,
    log.request_id ? `request_id: ${log.request_id}` : null,
    log.metadata ? `detail: ${JSON.stringify(log.metadata).slice(0, 500)}` : null,
  ];

  return lines.filter(Boolean).join("\n");
}

/* -------------------------------------- Functions -------------------------------------- */

// Function นับ login ผิดของ IP คืน true ครั้งเดียวตอนแตะเกณฑ์ในช่วงเวลา (ใช้สร้างเหตุการณ์ brute force)
export function trackFailedLogin(ip: string | null): { suspected: boolean; count: number; windowMinutes: number } {
  const { threshold, windowMs } = getBruteForceConfig();
  const windowMinutes = Math.round(windowMs / 60_000);

  if (!ip) {
    return { suspected: false, count: 0, windowMinutes };
  }

  const now = Date.now();
  const current = failedLoginsByIp.get(ip);
  const entry = current && now - current.windowStart < windowMs ? current : { count: 0, windowStart: now };

  entry.count += 1;
  failedLoginsByIp.set(ip, entry);
  pruneExpired(failedLoginsByIp, (value) => now - value.windowStart >= windowMs);

  return { suspected: entry.count === threshold, count: entry.count, windowMinutes };
}

// Function ส่งแจ้งเตือนเข้า LINE เมื่อเหตุการณ์เป็น critical (ไม่ตั้ง SECURITY_ALERT_LINE_TO = ไม่ส่ง / เรื่องเดิมไม่ส่งซ้ำในช่วง cooldown)
export async function notifyIfCritical(log: AuditLogCreateInput): Promise<void> {
  if (log.severity !== "critical") {
    return;
  }

  logger.warn("Security alert.", { alertCode: "SECURITY_ALERT", action: log.action, actorAccountId: log.actor_account_id, ip: log.ip_address });

  const { lineTo, cooldownMs } = getSecurityAlertConfig();
  await sendLineAlert({
    lineTo,
    cooldownMs,
    cooldownKey: `security|${log.action}|${log.ip_address ?? ""}|${log.actor_account_id ?? ""}`,
    text: buildAlertText(log),
  });
}

// Function ส่งข้อความแจ้งเตือนเข้า LINE (ไม่ตั้งปลายทางหรือ LINE_CHANNEL_ACCESS_TOKEN = ไม่ส่ง / key เดิมไม่ส่งซ้ำในช่วง cooldown)
// error ทุกชนิดแค่เขียน log ไม่ throw (แจ้งเตือนพังต้องไม่ทำให้งานหลักพัง)
export async function sendLineAlert(alert: { lineTo: string | null; cooldownMs: number; cooldownKey: string; text: string }): Promise<boolean> {
  const token = readOptionalEnv("LINE_CHANNEL_ACCESS_TOKEN");

  if (!alert.lineTo || !token) {
    return false;
  }

  const now = Date.now();

  if ((alertCooldowns.get(alert.cooldownKey) ?? 0) > now) {
    return false;
  }

  alertCooldowns.set(alert.cooldownKey, now + alert.cooldownMs);
  pruneExpired(alertCooldowns, (until) => until <= now);

  try {
    const response = await fetch(LINE_API_CONFIG.pushUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: alert.lineTo, messages: [{ type: "text", text: alert.text.slice(0, LINE_TEXT_MAX_LENGTH) }] }),
      signal: AbortSignal.timeout(LINE_API_CONFIG.timeoutMs),
    });

    if (!response.ok) {
      logger.warn("Failed to send alert to LINE.", { cooldownKey: alert.cooldownKey, httpStatus: response.status });
      return false;
    }

    return true;
  } catch (error) {
    logger.warn("Failed to send alert to LINE.", { cooldownKey: alert.cooldownKey, error });
    return false;
  }
}

// Function ล้างตัวนับและ cooldown ทั้งหมด (ใช้ใน test)
export function resetSecurityAlertState(): void {
  failedLoginsByIp.clear();
  alertCooldowns.clear();
}
