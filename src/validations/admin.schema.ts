// Import Library
import { z } from "zod";
// Import Validations
import { fullNameSchema, newPasswordSchema, permissionsSchema, roleSchema, statusSchema, usernameSchema } from "./auth.schema";

/* -------------------------------------- Schemas -------------------------------------- */

// Schema id ของบัญชีใน path param
export const accountIdParamSchema = z.coerce.number().int().positive();

// Schema body ของ POST /api/admins (ต้องระบุ permissions ตอนสร้างเสมอ ส่ง [] ได้)
export const createAdminBodySchema = z.object({
  username: usernameSchema,
  password: newPasswordSchema,
  full_name: fullNameSchema,
  role: roleSchema,
  status: statusSchema.default("active"),
  permissions: permissionsSchema,
});

// Schema body ของ PATCH /api/admins/:id (ส่งเฉพาะ field ที่ต้องการเปลี่ยน permissions = แทนที่ทั้งชุด)
export const updateAdminBodySchema = z
  .object({
    full_name: fullNameSchema.optional(),
    role: roleSchema.optional(),
    status: statusSchema.optional(),
    permissions: permissionsSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), { message: "At least one field is required." });

// Schema body ของ PATCH /api/admins/:id/password
export const resetAdminPasswordBodySchema = z.object({
  new_password: newPasswordSchema,
});
