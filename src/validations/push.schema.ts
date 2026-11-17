// Import Library
import { z } from "zod";

/* -------------------------------------- Formats -------------------------------------- */

// Format ข้อความที่ trim แล้วและห้ามว่าง
const trimmedString = z.string().trim().min(1);

/* -------------------------------------- Body Schemas -------------------------------------- */

// Schema body ของ /api/line/push (to/messages ส่งต่อให้ LINE ตามเดิม ตัวข้อความไม่ตรวจลึก ให้ LINE เป็นคนตรวจ)
export const linePushBodySchema = z.object({
  smm_app: trimmedString,
  to: trimmedString.max(64),
  messages: z.array(z.record(z.string(), z.unknown())).min(1).max(5),
  // ส่งค่าเดิมทุกครั้งที่ retry ข้อความเดียวกัน LINE จะไม่ส่งซ้ำ
  retry_key: z.uuid().optional(),
});
