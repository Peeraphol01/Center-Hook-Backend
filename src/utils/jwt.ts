// Import Library
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import { z, type ZodType } from "zod";
// Import Config
import { getAccessTokenExpiresInSeconds, getRefreshThresholdSeconds, getRefreshTokenExpiresInSeconds, readSecret } from "../config/auth.config";
import { PERMISSIONS, ROLES } from "../config/permission.config";
// Import Types
import type { AccessTokenPayload, RefreshTokenPayload } from "../types/auth.types";
// Import Utils
import { ApiError } from "./api-helper";

/* -------------------------------------- Config -------------------------------------- */

// Config schema ของ payload แต่ละชนิด (กัน token ที่เซ็นถูกแต่ payload ผิดรูป และกันเอา refresh token มาใช้แทน access token)
const accessPayloadSchema = z.object({
  token_type: z.literal("access"),
  account_id: z.number().int().positive(),
  session_id: z.number().int().positive(),
  role: z.enum(ROLES),
  // สิทธิ์ที่ไม่รู้จักแล้ว (เช่นถูกลบออกจาก config) ตัดทิ้ง ไม่ทำให้ token พัง
  permissions: z.array(z.string()).transform((items) => items.filter((item) => (PERMISSIONS as readonly string[]).includes(item))),
  iat: z.number().optional(),
  exp: z.number().optional(),
}) as unknown as ZodType<AccessTokenPayload>;

const refreshPayloadSchema = z.object({
  token_type: z.literal("refresh"),
  account_id: z.number().int().positive(),
  session_id: z.number().int().positive(),
  iat: z.number().optional(),
  exp: z.number().optional(),
}) as ZodType<RefreshTokenPayload>;

// Config secret, schema และ error code ของ token แต่ละชนิด
const TOKEN_TYPES = {
  access: { secretName: "JWT_ACCESS_SECRET", schema: accessPayloadSchema, invalidCode: "INVALID_TOKEN" },
  refresh: { secretName: "JWT_REFRESH_SECRET", schema: refreshPayloadSchema, invalidCode: "INVALID_REFRESH_TOKEN" },
} as const;

/* -------------------------------------- Helpers -------------------------------------- */

// Function ตรวจ JWT (HS256 เท่านั้น) แล้ว validate payload ตามชนิด token
function verifyTyped<T>(token: string, type: keyof typeof TOKEN_TYPES): T {
  const config = TOKEN_TYPES[type];
  let decoded: unknown;

  try {
    decoded = jwt.verify(token, readSecret(config.secretName), { algorithms: ["HS256"] });
  } catch (error) {
    if (error instanceof Error && error.name === "TokenExpiredError") {
      throw new ApiError(401, "TOKEN_EXPIRED", "Token expired.");
    }

    throw new ApiError(401, config.invalidCode, "Invalid token.");
  }

  const result = (config.schema as ZodType<T>).safeParse(decoded);

  if (!result.success) {
    throw new ApiError(401, config.invalidCode, "Invalid token.");
  }

  return result.data;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function เซ็น access token
export function signAccessToken(payload: Omit<AccessTokenPayload, "token_type" | "iat" | "exp">): string {
  return jwt.sign({ ...payload, token_type: "access" }, readSecret("JWT_ACCESS_SECRET"), {
    algorithm: "HS256",
    expiresIn: getAccessTokenExpiresInSeconds(),
    jwtid: randomUUID(),
  });
}

// Function เซ็น refresh token
export function signRefreshToken(payload: Omit<RefreshTokenPayload, "token_type" | "iat" | "exp">): string {
  return jwt.sign({ ...payload, token_type: "refresh" }, readSecret("JWT_REFRESH_SECRET"), {
    algorithm: "HS256",
    expiresIn: getRefreshTokenExpiresInSeconds(),
    // jti สุ่มทุกครั้ง: refresh ซ้ำในวินาทีเดียวกันจะได้ token ไม่ซ้ำ (ไม่งั้น hash เท่าเดิมและ token เก่ายังใช้ได้)
    jwtid: randomUUID(),
  });
}

// Function ตรวจ access token
export function verifyAccessToken(token: string): AccessTokenPayload {
  return verifyTyped<AccessTokenPayload>(token, "access");
}

// Function ตรวจ refresh token
export function verifyRefreshToken(token: string): RefreshTokenPayload {
  return verifyTyped<RefreshTokenPayload>(token, "refresh");
}

// Function เช็คว่า access token ใกล้หมดอายุหรือยัง (ใช้ตั้ง header X-Should-Refresh)
export function isAccessTokenNearingExpiry(exp: number | undefined): boolean {
  return typeof exp === "number" && exp - Math.floor(Date.now() / 1000) <= getRefreshThresholdSeconds();
}
