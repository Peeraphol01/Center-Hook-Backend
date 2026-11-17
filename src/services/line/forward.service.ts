// Import Config
import { FORWARD_CONFIG } from "../../config/app.config";
// Import Utils
import { truncate } from "../../utils/text";
// Import Types
import type { ForwardAttemptResult } from "../../types/line.types";
import type { ForwardResult } from "../../types/log.types";

/* -------------------------------------- Helpers -------------------------------------- */

// Function รอเวลาก่อน retry
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function ส่ง POST หนึ่งครั้ง (5xx, 429, timeout และ network error ถือว่า retry ได้)
async function postOnce(url: string, body: string, signature: string): Promise<ForwardAttemptResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-line-signature": signature, "user-agent": "center-hook" },
      body,
      signal: AbortSignal.timeout(FORWARD_CONFIG.timeoutMs),
    });
    const responseBody = truncate(await response.text().catch(() => null), FORWARD_CONFIG.maxResponseBodyLength);

    return {
      ok: response.ok,
      retryable: response.status >= 500 || response.status === 429,
      http_status: response.status,
      response_body: responseBody,
      error_message: response.ok ? null : `HTTP ${response.status}`,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === "TimeoutError";

    return {
      ok: false,
      retryable: true,
      http_status: null,
      response_body: null,
      error_message: isTimeout
        ? `Timeout after ${FORWARD_CONFIG.timeoutMs}ms`
        : error instanceof Error ? (error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message) : String(error),
    };
  }
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ส่ง body ที่เซ็นแล้วไปปลายทาง พร้อม retry แบบ backoff สั้นๆ
export async function forwardToTarget(url: string, body: string, signature: string): Promise<ForwardResult> {
  const startedAt = Date.now();
  let attempts = 0;
  let last: ForwardAttemptResult | null = null;

  while (attempts < FORWARD_CONFIG.maxAttempts) {
    if (attempts > 0) {
      await delay(FORWARD_CONFIG.retryDelayMs * attempts);
    }

    attempts += 1;
    last = await postOnce(url, body, signature);

    if (last.ok || !last.retryable) {
      break;
    }
  }

  return {
    status: last?.ok ? "SUCCESS" : "FAILED",
    http_status: last?.http_status ?? null,
    response_body: last?.response_body ?? null,
    error_message: last?.error_message ?? null,
    attempts,
    duration_ms: Date.now() - startedAt,
    forwarded_at: new Date(),
  };
}
