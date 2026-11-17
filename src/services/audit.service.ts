// Import Library
import { tryGetContext } from "hono/context-storage";
// Import Config
import { getAuditLogRetentionDays } from "../config/security.config";
// Import Repositories
import * as accountRepository from "../repositories/account.repository";
import * as auditRepository from "../repositories/audit.repository";
// Import Services
import { reportError } from "./error-report.service";
import { lookupIp } from "./geoip.service";
import * as securityAlertService from "./security-alert.service";
// Import Types
import type { AppEnv } from "../types/app.types";
import type {
  AuditAction,
  AuditEventInput,
  AuditLogCreateInput,
  AuditLogDto,
  AuditLogListResponse,
  AuditSeverity,
  SecuritySummaryResponse,
} from "../types/audit.types";
// Import Utils
import { ApiError, getClientIp, parseWithSchema } from "../utils/api-helper";
import { runInBackground } from "../utils/background-tasks";
import { logger } from "../utils/logger";
// Import Validations
import { auditLogIdParamSchema, auditLogListQuerySchema, securitySummaryQuerySchema } from "../validations/audit.schema";

/* -------------------------------------- Config -------------------------------------- */

// Config ความรุนแรงตั้งต้นของแต่ละเหตุการณ์ (critical = แจ้งเตือนทันที)
const AUDIT_DEFAULT_SEVERITY: Record<AuditAction, AuditSeverity> = {
  "auth.login.success": "info",
  "auth.login.failed": "warning",
  "auth.login.new_ip": "warning",
  "auth.login.blocked": "warning",
  "auth.login.device_conflict": "warning",
  // critical = แจ้งเตือนเข้า LINE ทุกครั้งที่มีการเตะเครื่องเดิม (ถ้าไม่ใช่เจ้าของบัญชีทำเองจะได้รู้ทันที)
  "auth.session.replaced": "critical",
  "auth.account.locked": "critical",
  "auth.logout": "info",
  "auth.refresh.success": "info",
  "auth.refresh.failed": "warning",
  "auth.refresh.reuse_detected": "critical",
  "auth.password.changed": "warning",
  "auth.password.change_failed": "warning",
  "admin.create": "info",
  "admin.update": "info",
  "admin.delete": "warning",
  "webhook.create": "warning",
  "webhook.update": "warning",
  "webhook.delete": "warning",
  "access.denied": "warning",
  "security.ip_blocked": "warning",
  "security.brute_force_suspected": "critical",
  "line.webhook.invalid_signature": "warning",
  "line.push.unauthorized": "warning",
};

// Config action ที่นับเป็น "login ไม่สำเร็จ" ในสรุปความปลอดภัย
const FAILED_LOGIN_ACTIONS: readonly AuditAction[] = ["auth.login.failed", "auth.login.blocked"];
const DENIED_ACTIONS: readonly AuditAction[] = ["access.denied", "security.ip_blocked", "line.push.unauthorized", "line.webhook.invalid_signature"];

// Config ช่วงเวลาที่ไม่บันทึกเหตุการณ์ซ้ำต่อ key (เหตุการณ์ที่โดนยิงถี่ได้ เช่น IP ถูกบล็อก)
const throttledUntil = new Map<string, number>();
const MAX_THROTTLE_KEYS = 10_000;

/* -------------------------------------- Helpers -------------------------------------- */

// Function ข้ามเหตุการณ์ที่ซ้ำภายในช่วง throttle คืน true ถ้าควรข้าม
function isThrottled(key: string | undefined, windowMs: number): boolean {
  if (!key) {
    return false;
  }

  const now = Date.now();

  if ((throttledUntil.get(key) ?? 0) > now) {
    return true;
  }

  if (throttledUntil.size >= MAX_THROTTLE_KEYS) {
    throttledUntil.clear();
  }

  throttledUntil.set(key, now + windowMs);
  return false;
}

// Function อ่านข้อมูลของ request ปัจจุบัน (เรียกนอก request เช่นงานตั้งเวลา = ค่าว่าง)
function readRequestMeta(): Pick<AuditLogCreateInput, "ip_address" | "user_agent" | "request_id" | "method" | "path"> & {
  auth_account_id: number | null;
  auth_session_id: number | null;
} {
  const c = tryGetContext<AppEnv>();

  if (!c) {
    return { ip_address: null, user_agent: null, request_id: null, method: null, path: null, auth_account_id: null, auth_session_id: null };
  }

  const auth = c.get("auth");

  return {
    ip_address: getClientIp(c),
    user_agent: c.req.header("user-agent") ?? null,
    request_id: c.get("requestId") ?? null,
    method: c.req.method,
    path: c.req.path,
    auth_account_id: auth?.account_id ?? null,
    auth_session_id: auth?.session_id ?? null,
  };
}

// Function บันทึกแถวลง DB แล้วแจ้งเตือนถ้า critical (DB ล้ม = เขียนเหตุการณ์ลง log ของ process แทน หลักฐานไม่หาย)
async function persist(row: AuditLogCreateInput): Promise<void> {
  if (!row.actor_username && row.actor_account_id) {
    row.actor_username = (await accountRepository.findById(row.actor_account_id).catch(() => null))?.username ?? null;
  }

  try {
    await auditRepository.createAuditLog(row);
  } catch (error) {
    logger.error("Failed to write audit log.", { audit: row, error });
    void reportError(error, { source: "audit-log", extra: { action: row.action } });
  }

  await securityAlertService.notifyIfCritical(row);
}

/* -------------------------------------- Functions -------------------------------------- */

// Function บันทึก audit log (ไม่รอ DB: เขียนเบื้องหลังหลังตอบ request) IP / user agent / request id / ผู้ login อ่านจาก request ปัจจุบันให้เอง
// throttleKey = ไม่บันทึกเหตุการณ์ key เดียวกันซ้ำภายใน throttleMs (ใช้กับเหตุการณ์ที่ถูกยิงถี่ได้)
export function recordAudit(event: AuditEventInput, options: { throttleKey?: string; throttleMs?: number } = {}): void {
  const meta = readRequestMeta();

  if (isThrottled(options.throttleKey && `${event.action}|${options.throttleKey}`, options.throttleMs ?? 60_000)) {
    return;
  }

  const { auth_account_id: authAccountId, auth_session_id: authSessionId, ...requestMeta } = meta;
  const geo = lookupIp(requestMeta.ip_address);
  const row: AuditLogCreateInput = {
    action: event.action,
    result: event.result,
    severity: event.severity ?? AUDIT_DEFAULT_SEVERITY[event.action],
    actor_account_id: event.actor_account_id !== undefined ? event.actor_account_id : authAccountId,
    actor_username: event.actor_username ?? null,
    session_id: event.session_id !== undefined ? event.session_id : authSessionId,
    target_type: event.target_type ?? null,
    target_id: event.target_id === undefined || event.target_id === null ? null : String(event.target_id),
    metadata: event.metadata ?? null,
    ...requestMeta,
    geo_country: geo.country,
    geo_city: geo.city,
  };

  runInBackground("audit-log", () => persist(row));

  // login ผิดจาก IP เดียวกันถี่เกินเกณฑ์ = สงสัย brute force (บันทึกครั้งเดียวต่อช่วงเวลา)
  if (event.action === "auth.login.failed") {
    const tracked = securityAlertService.trackFailedLogin(row.ip_address);

    if (tracked.suspected) {
      recordAudit({
        action: "security.brute_force_suspected",
        result: "denied",
        actor_account_id: null,
        session_id: null,
        metadata: { failed_logins: tracked.count, window_minutes: tracked.windowMinutes, last_username: event.actor_username ?? null },
      });
    }
  }
}

// Function ค้นหา audit log แบบแบ่งหน้าตาม filter
export async function listAuditLogs(query: unknown): Promise<AuditLogListResponse> {
  const { page, limit, ...filters } = parseWithSchema(auditLogListQuerySchema, query);
  const { items, total } = await auditRepository.listAuditLogs(filters, page, limit);

  return { data: items, pagination: { page, limit, total, total_pages: Math.ceil(total / limit) } };
}

// Function ดึง audit log หนึ่งรายการ
export async function getAuditLog(idParam: unknown): Promise<AuditLogDto> {
  const id = parseWithSchema(auditLogIdParamSchema, idParam, { message: "Invalid id." });
  const log = await auditRepository.findAuditLogById(BigInt(id));

  if (!log) {
    throw new ApiError(404, "AUDIT_LOG_NOT_FOUND", "Audit log not found.");
  }

  return log;
}

// Function สรุปความผิดปกติในช่วงเวลา: จำนวนแต่ละเหตุการณ์, IP/username ที่ login ผิดบ่อย, IP ที่ถูกปฏิเสธบ่อย, เหตุการณ์ warning/critical ล่าสุด
export async function getSecuritySummary(query: unknown): Promise<SecuritySummaryResponse> {
  const { hours, top } = parseWithSchema(securitySummaryQuerySchema, query);
  const to = new Date();
  const from = new Date(to.getTime() - hours * 60 * 60 * 1000);

  const [countsByAction, failedIps, failedUsernames, deniedIps, recentAlerts] = await Promise.all([
    auditRepository.countByAction(from, to),
    auditRepository.topValuesForActions("ipAddress", FAILED_LOGIN_ACTIONS, from, to, top),
    auditRepository.topValuesForActions("actorUsername", FAILED_LOGIN_ACTIONS, from, to, top),
    auditRepository.topValuesForActions("ipAddress", DENIED_ACTIONS, from, to, top),
    auditRepository.listRecentBySeverity(["warning", "critical"], from, to, 50),
  ]);

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    counts_by_action: countsByAction,
    top_failed_login_ips: failedIps.map(({ value, count }) => ({ ip_address: value, count })),
    top_failed_login_usernames: failedUsernames.map(({ value, count }) => ({ username: value, count })),
    top_denied_ips: deniedIps.map(({ value, count }) => ({ ip_address: value, count })),
    recent_alerts: recentAlerts,
  };
}

// Function ลบ audit log ที่เก่ากว่า AUDIT_LOG_RETENTION_DAYS คืนจำนวนที่ลบ
export async function deleteExpiredAuditLogs(): Promise<number> {
  const before = new Date(Date.now() - getAuditLogRetentionDays() * 24 * 60 * 60 * 1000);

  return auditRepository.deleteAuditLogsBefore(before);
}

// Function ล้าง throttle ทั้งหมด (ใช้ใน test)
export function resetAuditThrottle(): void {
  throttledUntil.clear();
}
