// Import Library
import { z } from "zod";
// Import Types
import { AUDIT_SEVERITIES } from "../types/audit.types";

/* -------------------------------------- Formats -------------------------------------- */

// Format ข้อความที่ trim แล้วและห้ามว่าง
const trimmedString = z.string().trim().min(1);

/* -------------------------------------- Query Schemas -------------------------------------- */

// Schema query สำหรับค้นหา audit log (from/to รับ ISO date หรือ datetime)
export const auditLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  action: trimmedString.max(100).optional(),
  // เช่น auth. = ทุกเหตุการณ์ของ login/session
  action_prefix: trimmedString.max(100).optional(),
  result: z.enum(["success", "failure", "denied"]).optional(),
  severity: z.enum(AUDIT_SEVERITIES).optional(),
  actor_account_id: z.coerce.number().int().positive().optional(),
  actor_username: trimmedString.max(100).optional(),
  ip_address: trimmedString.max(64).optional(),
  target_type: trimmedString.max(50).optional(),
  target_id: trimmedString.max(100).optional(),
  request_id: trimmedString.max(255).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Schema id ใน path param (BIGINT รับเป็นตัวเลขล้วน)
export const auditLogIdParamSchema = z.string().regex(/^[1-9]\d{0,18}$/);

// Schema query ของสรุปความปลอดภัย (ย้อนหลังกี่ชั่วโมง และกี่อันดับ)
export const securitySummaryQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(24 * 90).default(24),
  top: z.coerce.number().int().min(1).max(50).default(10),
});
