/* -------------------------------------- Types -------------------------------------- */

// Type ชื่อเหตุการณ์ที่บันทึกลง audit log
export const AUDIT_ACTIONS = [
  // login / session
  "auth.login.success",
  "auth.login.failed",
  // login สำเร็จจาก IP ที่บัญชีนี้ไม่เคยใช้มาก่อน
  "auth.login.new_ip",
  // พยายาม login ระหว่างบัญชีถูกล็อก
  "auth.login.blocked",
  // รหัสถูกแต่บัญชีใช้งานอยู่บนเครื่องอื่น (ตอบ 409 ให้ยืนยันก่อนเตะเครื่องเดิม)
  "auth.login.device_conflict",
  // ยืนยัน login เครื่องใหม่แล้ว session ของเครื่องเดิมถูกเตะออก
  "auth.session.replaced",
  "auth.account.locked",
  "auth.logout",
  "auth.refresh.success",
  "auth.refresh.failed",
  // refresh token ที่หมุนไปแล้วถูกนำกลับมาใช้ (token น่าจะถูกขโมย) session ถูก revoke ทันที
  "auth.refresh.reuse_detected",
  "auth.password.changed",
  "auth.password.change_failed",
  // จัดการบัญชีผู้ดูแล
  "admin.create",
  "admin.update",
  "admin.delete",
  // จัดการ webhook ปลายทาง
  "webhook.create",
  "webhook.update",
  "webhook.delete",
  // การเข้าถึงที่ถูกปฏิเสธ / ความผิดปกติ
  "access.denied",
  "security.ip_blocked",
  "security.brute_force_suspected",
  "line.webhook.invalid_signature",
  "line.push.unauthorized",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

// Type ผลของเหตุการณ์
export type AuditResult = "success" | "failure" | "denied";

// Type ความรุนแรง (critical = ส่งแจ้งเตือนทันที)
export const AUDIT_SEVERITIES = ["info", "warning", "critical"] as const;
export type AuditSeverity = (typeof AUDIT_SEVERITIES)[number];

// Type ข้อมูลที่ service ส่งมาบันทึก (ข้อมูลของ request เช่น IP เติมให้เองจาก context)
export interface AuditEventInput {
  action: AuditAction;
  result: AuditResult;
  // ไม่ส่ง = ใช้ค่าตาม AUDIT_DEFAULT_SEVERITY
  severity?: AuditSeverity;
  // ไม่ส่ง = ใช้ผู้ดูแลที่ login อยู่ใน request นี้
  actor_account_id?: number | null;
  actor_username?: string | null;
  session_id?: number | null;
  target_type?: string | null;
  target_id?: string | number | null;
  metadata?: Record<string, unknown> | null;
}

// Type แถวที่ repository บันทึก
export interface AuditLogCreateInput {
  action: AuditAction;
  result: AuditResult;
  severity: AuditSeverity;
  actor_account_id: number | null;
  actor_username: string | null;
  session_id: number | null;
  target_type: string | null;
  target_id: string | null;
  ip_address: string | null;
  // ตำแหน่งโดยประมาณของ IP (MaxMind GeoLite2) null = หาไม่เจอ เช่น IP ภายใน
  geo_country: string | null;
  geo_city: string | null;
  user_agent: string | null;
  request_id: string | null;
  method: string | null;
  path: string | null;
  metadata: Record<string, unknown> | null;
}

// Type ส่วน DTO ของ table audit_logs
export interface AuditLogDto extends AuditLogCreateInput {
  id: string;
  occurred_at: string;
}

// Type ส่วน Filters ของการค้นหา audit log
export interface AuditLogFilters {
  action?: string;
  // prefix ของ action เช่น auth. = ทุกเหตุการณ์ของ login
  action_prefix?: string;
  result?: AuditResult;
  severity?: AuditSeverity;
  actor_account_id?: number;
  actor_username?: string;
  ip_address?: string;
  target_type?: string;
  target_id?: string;
  request_id?: string;
  from?: Date;
  to?: Date;
}

// Type ส่วน Response ของ API รายการ audit log
export interface AuditLogListResponse {
  data: AuditLogDto[];
  pagination: { page: number; limit: number; total: number; total_pages: number };
}

// Type ส่วน Response ของสรุปความปลอดภัย
export interface SecuritySummaryResponse {
  from: string;
  to: string;
  counts_by_action: { action: string; count: number }[];
  top_failed_login_ips: { ip_address: string; count: number }[];
  top_failed_login_usernames: { username: string; count: number }[];
  top_denied_ips: { ip_address: string; count: number }[];
  recent_alerts: AuditLogDto[];
}
