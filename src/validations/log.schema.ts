// Import Library
import { z } from "zod";

/* -------------------------------------- Formats -------------------------------------- */

// Format ข้อความที่ trim แล้วและห้ามว่าง
const trimmedString = z.string().trim().min(1);

/* -------------------------------------- Query Schemas -------------------------------------- */

// Schema query สำหรับค้นหา forward log (from/to รับ ISO date หรือ datetime)
export const forwardLogListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  direction: z.enum(["INBOUND", "OUTBOUND"]).optional(),
  status: z.enum(["SUCCESS", "FAILED", "SKIPPED"]).optional(),
  project: trimmedString.optional(),
  line_user_id: trimmedString.optional(),
  event_type: trimmedString.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

// Schema id ใน path param
export const idParamSchema = z.coerce.number().int().positive();

// Schema query รายการแชท (จัดกลุ่มตาม LINE user)
export const conversationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  project: trimmedString.max(50).optional(),
  // LINE user id บางส่วน หรือชื่อโปรไฟล์ LINE
  search: trimmedString.max(100).optional(),
});

// Schema query ข้อความในแชท (โหลดย้อนหลังด้วย before_id)
export const conversationLogsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  project: trimmedString.max(50).optional(),
  before_id: z.coerce.number().int().positive().optional(),
});

// Schema LINE user/group id ใน path param
export const lineUserIdParamSchema = z.string().regex(/^[A-Za-z0-9]{1,64}$/);
