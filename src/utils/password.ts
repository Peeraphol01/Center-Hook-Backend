// Import Library
import argon2 from "argon2";
import PQueue from "p-queue";
// Import Config
import { readPositiveIntegerEnv } from "../config/env";
// Import Utils
import { ApiError } from "./api-helper";

/* -------------------------------------- Config -------------------------------------- */

// Config argon2id ตามค่าขั้นต่ำของ OWASP (hash เก็บพารามิเตอร์ไว้ในตัว เปลี่ยนค่าทีหลังยัง verify hash เดิมได้)
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

// Config คิวจำกัดจำนวน verify ที่รันพร้อมกัน (กัน CPU/RAM ตันตอนมีคนยิง login พร้อมกันเยอะ) คิวเต็มตอบ 503 ทันที
const verifyQueue = new PQueue({ concurrency: readPositiveIntegerEnv("ARGON2_MAX_CONCURRENCY", 4) });
const VERIFY_MAX_QUEUE = readPositiveIntegerEnv("ARGON2_MAX_QUEUE", 100);

/* -------------------------------------- Functions -------------------------------------- */

// Function hash password ด้วย argon2id
export async function hashPassword(password: string): Promise<string> {
  if (!password) {
    throw new TypeError("Password must be a non-empty string.");
  }

  return argon2.hash(password, ARGON2_OPTIONS);
}

// Function เทียบ password กับ hash (hash ว่างหรือผิดรูปแบบคืน false)
export async function verifyPassword(password: string, passwordHash: string | null | undefined): Promise<boolean> {
  if (!password || !passwordHash) {
    return false;
  }

  if (verifyQueue.size >= VERIFY_MAX_QUEUE) {
    throw new ApiError(503, "SERVER_BUSY", "Server is busy. Please try again shortly.");
  }

  return verifyQueue.add(async () => {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  });
}
