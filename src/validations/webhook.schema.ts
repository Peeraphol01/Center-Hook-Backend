// Import Library
import { z } from "zod";

/* -------------------------------------- Formats -------------------------------------- */

// Config ชื่อใน path ที่หมายถึง webhook default (smm_app = null) จึงห้ามใช้เป็นค่า smm_app
export const DEFAULT_WEBHOOK_PATH = "default";

// Format smm_app (ตัวพิมพ์เล็ก ตัวเลข _ - ไม่เกิน 50 ตัว ใช้ใน postback data และ path ได้โดยไม่ต้อง encode)
const smmAppFormat = z.string().trim().regex(/^[a-z0-9_-]{1,50}$/, "smm_app may contain only a-z, 0-9, _ and - (max 50).");

// Format smm_app ใน body (ห้ามเป็น "default" เพราะชนกับ path ของ webhook default)
const smmAppSchema = smmAppFormat.refine((value) => value !== DEFAULT_WEBHOOK_PATH, {
  message: `smm_app "${DEFAULT_WEBHOOK_PATH}" is reserved. Use null for the default webhook.`,
});

// Format webhook URL ปลายทาง (http/https เท่านั้น)
const webhookUrlSchema = z.url({ protocol: /^https?$/ }).max(1024);

/* -------------------------------------- Schemas -------------------------------------- */

// Schema body สำหรับสร้าง webhook (smm_app: null = webhook default)
export const webhookCreateBodySchema = z.object({
  smm_app: smmAppSchema.nullable(),
  webhook_url: webhookUrlSchema,
});

// Schema body สำหรับแก้ webhook (ส่งเฉพาะ field ที่ต้องการเปลี่ยน)
export const webhookUpdateBodySchema = z
  .object({
    smm_app: smmAppSchema.nullable().optional(),
    webhook_url: webhookUrlSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "At least one field is required." });

// Schema smm_app ใน path param ("default" = webhook default จึงแปลงเป็น null)
export const webhookSmmAppParamSchema = smmAppFormat.transform((value) => (value === DEFAULT_WEBHOOK_PATH ? null : value));
