// Import Library
import { z } from "zod";
// Import Config
import { PERMISSIONS, ROLES } from "../config/permission.config";

/* -------------------------------------- Formats -------------------------------------- */

// Format username (a-z A-Z 0-9 . _ - ยาว 3-100)
export const usernameSchema = z.string().trim().regex(/^[a-zA-Z0-9._-]{3,100}$/, "username may contain only a-z, A-Z, 0-9, . _ - (3-100 characters).");

// Format รหัสผ่านใหม่ (8-128 ตัว ไม่ trim เพราะช่องว่างเป็นส่วนหนึ่งของรหัสได้)
export const newPasswordSchema = z.string().min(8, "Password must be at least 8 characters.").max(128);

// Format ชื่อเต็ม
export const fullNameSchema = z.string().trim().min(1).max(255);

// Format role และสถานะบัญชี
export const roleSchema = z.enum(ROLES);
export const statusSchema = z.enum(["active", "inactive"]);

// Format รายการสิทธิ์ (ตัดตัวซ้ำและเรียงให้คงที่)
export const permissionsSchema = z
  .array(z.enum(PERMISSIONS))
  .max(PERMISSIONS.length * 2)
  .transform((items) => [...new Set(items)].sort());

/* -------------------------------------- Auth Schemas -------------------------------------- */

// Format รหัสเครื่อง (หน้าเว็บสร้างเก็บในคุกกี้ ch_device)
export const deviceIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "device_id may contain only a-z, A-Z, 0-9, _ - (16-128 characters).");

// Schema body ของ POST /api/auth/login (ไม่ตรวจรูปแบบ username ละเอียด ผิดก็ตอบ 401 เหมือนรหัสผิด)
// replace_session = true ยืนยันเตะเครื่องเดิมออก (ส่งหลังได้ 409 ACTIVE_ON_OTHER_DEVICE)
export const loginBodySchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(128),
  device_id: deviceIdSchema.optional(),
  replace_session: z.boolean().optional(),
});

// Schema body ของ POST /api/auth/refresh
export const refreshBodySchema = z.object({
  refresh_token: z.string().min(1).max(4096),
});

// Schema body ของ PATCH /api/auth/me/password
export const changeOwnPasswordBodySchema = z
  .object({
    current_password: z.string().min(1).max(128),
    new_password: newPasswordSchema,
  })
  .refine((body) => body.current_password !== body.new_password, {
    message: "New password must be different from the current password.",
    path: ["new_password"],
  });
