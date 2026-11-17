// Import Library
import { z } from "zod";

/* -------------------------------------- Config -------------------------------------- */

// Config schema ของค่า env แต่ละรูปแบบ (ค่าว่าง/ไม่ตั้งแปลงเป็น 0 จึงไม่ผ่าน positive)
const ENV_SCHEMAS = {
  requiredString: z.string().min(1),
  positiveInteger: z.coerce.number().int().positive(),
};

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า env ที่ต้องมี ถ้าไม่มีให้ throw ทันที
export function readRequiredEnv(name: string): string {
  const result = ENV_SCHEMAS.requiredString.safeParse(process.env[name]);

  if (!result.success) {
    throw new Error(`${name} is required.`);
  }

  return result.data;
}

// Function อ่านค่า env แบบไม่บังคับ (ค่าว่างคืน null)
export function readOptionalEnv(name: string): string | null {
  return process.env[name]?.trim() || null;
}

// Function อ่าน env เป็นจำนวนเต็มบวก (ไม่ตั้งใช้ fallback ถ้าตั้งผิดรูปแบบ throw)
export function readPositiveIntegerEnv(name: string, fallback: number): number {
  if (!process.env[name]) {
    return fallback;
  }

  const result = ENV_SCHEMAS.positiveInteger.safeParse(process.env[name]);

  if (!result.success) {
    throw new Error(`${name} must be set to a positive integer.`);
  }

  return result.data;
}
