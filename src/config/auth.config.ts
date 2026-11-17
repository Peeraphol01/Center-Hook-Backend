/* -------------------------------------- Config -------------------------------------- */

// Config หน่วยเวลาที่รองรับในค่า duration ของ env (เช่น 15m, 24h หรือเลขวินาที)
const TIME_UNIT_SECONDS = { s: 1, m: 60, h: 60 * 60, d: 24 * 60 * 60 } as const;
const DURATION_PATTERN = /^(\d+)([smhd])?$/;

// Config ค่า default ของอายุ token
export const AUTH_DEFAULTS = {
  accessTokenExpiresInSeconds: 15 * TIME_UNIT_SECONDS.m,
  refreshTokenExpiresInSeconds: 24 * TIME_UNIT_SECONDS.h,
  // เวลาก่อน access token หมดอายุที่ตอบ header X-Should-Refresh: true ให้ client ไป /refresh เอง
  refreshThresholdSeconds: 2 * TIME_UNIT_SECONDS.m,
} as const;

// Config ค่า secret ที่ห้ามใช้ (สั้นเกินหรือเป็น placeholder จาก .env.example)
const WEAK_SECRET_VALUES = new Set(["secret", "password", "change-me"]);
const MIN_SECRET_LENGTH = 32;

// Config ค่า default ของการล็อกบัญชีเมื่อใส่รหัสผิดติดกัน
const LOCKOUT_DEFAULTS = { maxFailedAttempts: 5, lockMinutes: 15 } as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านจำนวนครั้งที่ใส่รหัสผิดติดกันได้ก่อนล็อก และเวลาล็อก (นาที) ค่าผิดรูปใช้ค่า default
export function getLoginLockoutConfig(): { maxFailedAttempts: number; lockMs: number } {
  const readInt = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };

  return {
    maxFailedAttempts: readInt(process.env.LOGIN_MAX_FAILED_ATTEMPTS, LOCKOUT_DEFAULTS.maxFailedAttempts),
    lockMs: readInt(process.env.LOGIN_LOCK_MINUTES, LOCKOUT_DEFAULTS.lockMinutes) * 60 * 1000,
  };
}

// Function แปลง duration เป็นวินาที (รูปแบบผิดหรือไม่ตั้งใช้ fallback)
function parseDurationSeconds(value: string | undefined, fallbackSeconds: number): number {
  const match = value?.trim().match(DURATION_PATTERN);

  if (!match) {
    return fallbackSeconds;
  }

  return Number(match[1]) * TIME_UNIT_SECONDS[(match[2] || "s") as keyof typeof TIME_UNIT_SECONDS];
}

// Function อ่านอายุ access token (วินาที)
export function getAccessTokenExpiresInSeconds(): number {
  return parseDurationSeconds(process.env.JWT_ACCESS_EXPIRES_IN, AUTH_DEFAULTS.accessTokenExpiresInSeconds);
}

// Function อ่านอายุ refresh token (วินาที) ใช้ทั้ง exp ของ JWT และ expires_at ของ session
export function getRefreshTokenExpiresInSeconds(): number {
  return parseDurationSeconds(process.env.JWT_REFRESH_EXPIRES_IN, AUTH_DEFAULTS.refreshTokenExpiresInSeconds);
}

// Function อ่าน threshold เตือน refresh (ต้องน้อยกว่าอายุ access token เสมอ ไม่งั้นใช้ครึ่งหนึ่งของอายุ)
export function getRefreshThresholdSeconds(): number {
  const threshold = parseDurationSeconds(process.env.ACCESS_TOKEN_REFRESH_THRESHOLD, AUTH_DEFAULTS.refreshThresholdSeconds);
  const accessSeconds = getAccessTokenExpiresInSeconds();

  return threshold > 0 && threshold < accessSeconds ? threshold : Math.floor(accessSeconds / 2);
}

// Function อ่าน secret จาก env และบังคับให้แข็งแรงพอ (อ่านทุกครั้งที่ใช้ ไม่ cache ตอนโหลด)
export function readSecret(name: "JWT_ACCESS_SECRET" | "JWT_REFRESH_SECRET" | "REFRESH_TOKEN_HASH_SECRET"): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} must be configured.`);
  }

  if (value.length < MIN_SECRET_LENGTH || WEAK_SECRET_VALUES.has(value) || value.startsWith("CHANGE_ME")) {
    throw new Error(`${name} must be a strong value (at least ${MIN_SECRET_LENGTH} characters, not a placeholder).`);
  }

  return value;
}
