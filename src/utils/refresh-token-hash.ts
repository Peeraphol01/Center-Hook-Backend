// Import Library
import { createHmac, timingSafeEqual } from "node:crypto";
// Import Config
import { readSecret } from "../config/auth.config";

/* -------------------------------------- Functions -------------------------------------- */

// Function hash refresh token ด้วย HMAC-SHA256 ก่อนเก็บลง DB (DB หลุดก็เอา hash ไปใช้ refresh ไม่ได้)
export function hashRefreshToken(refreshToken: string): string {
  const digest = createHmac("sha256", readSecret("REFRESH_TOKEN_HASH_SECRET")).update(refreshToken).digest("base64url");

  return `hmac-sha256$${digest}`;
}

// Function เทียบ hash ของ refresh token แบบ timing-safe
export function refreshTokenHashesMatch(candidate: string | null | undefined, stored: string | null | undefined): boolean {
  if (!candidate || !stored) {
    return false;
  }

  const candidateBuffer = Buffer.from(candidate);
  const storedBuffer = Buffer.from(stored);

  return candidateBuffer.length === storedBuffer.length && timingSafeEqual(candidateBuffer, storedBuffer);
}
