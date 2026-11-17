// Import Library
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
// Import Config
import { FORWARD_CONFIG } from "../../config/app.config";
// Import Repositories
import * as forwardLogRepository from "../../repositories/log.repository";
// Import Services
import { recordAudit } from "../audit.service";
import { reportError, trackForwardResult } from "../error-report.service";
import * as webhookService from "../webhook.service";
import * as lineForwardService from "./forward.service";
import * as pushService from "./push.service";
// Import Runtime
import { runInBackground } from "../../utils/background-tasks";
// Import Types
import type { ForwardResult } from "../../types/log.types";
import type { LineWebhookBody, LineWebhookEvent } from "../../types/line.types";
// Import Utils
import { truncate } from "../../utils/text";
import { ApiError } from "../../utils/api-helper";
import { logger } from "../../utils/logger";

/* -------------------------------------- Helpers -------------------------------------- */

// Function สร้าง x-line-signature (HMAC-SHA256 base64 ของ body ด้วย channel secret)
function signLineBody(body: string, channelSecret: string): string {
  return createHmac("sha256", channelSecret).update(body).digest("base64");
}

// Function ตรวจ x-line-signature แบบ timing-safe
function isValidLineSignature(body: string, channelSecret: string, signature: string): boolean {
  const expected = Buffer.from(signLineBody(body, channelSecret));
  const received = Buffer.from(signature);

  return expected.length === received.length && timingSafeEqual(expected, received);
}

// Function ดึง LINE channel secret (ไม่ตั้งตอบ 503)
function getChannelSecret(): string {
  const secret = process.env.LINE_CHANNEL_SECRET;

  if (!secret) {
    throw new ApiError(503, "LINE_WEBHOOK_NOT_CONFIGURED", "LINE webhook is not configured.");
  }

  return secret;
}

// Function ตรวจ x-line-signature ของ request ที่ LINE ส่งมา
function verifySignature(rawBody: string | undefined, signature: string | undefined, secret: string): string {
  if (!rawBody || !signature) {
    recordAudit({ action: "line.webhook.invalid_signature", result: "denied", metadata: { reason: "missing_signature" } }, { throttleKey: "missing" });
    throw new ApiError(401, "INVALID_LINE_SIGNATURE", "LINE signature is required.");
  }

  if (!isValidLineSignature(rawBody, secret, signature)) {
    recordAudit({ action: "line.webhook.invalid_signature", result: "denied", metadata: { reason: "signature_mismatch" } }, { throttleKey: "mismatch" });
    logger.error("LINE webhook signature mismatch. Check LINE_CHANNEL_SECRET.", { alertCode: "LINE_SIGNATURE_MISMATCH" });
    throw new ApiError(401, "INVALID_LINE_SIGNATURE", "LINE signature is invalid.");
  }

  return rawBody;
}

// Function parse body ของ LINE webhook (รับเฉพาะ object)
function parseWebhookBody(rawBody: string): LineWebhookBody {
  try {
    const body: unknown = JSON.parse(rawBody);

    if (body && typeof body === "object" && !Array.isArray(body)) {
      return body as LineWebhookBody;
    }
  } catch {
    // ตกไป throw ด้านล่าง
  }

  throw new ApiError(400, "VALIDATION_ERROR", "Invalid JSON body.");
}

// Function สรุปเนื้อหาของ event สำหรับเก็บใน log (ข้อความ, postback data หรือชนิดข้อความ)
function describeEventContent(event: LineWebhookEvent): string | null {
  if (event.type === "message") {
    return event.message?.type === "text" ? event.message.text ?? null : `[${event.message?.type ?? "unknown"}]`;
  }

  if (event.type === "postback") {
    return event.postback?.data ?? null;
  }

  return null;
}

// Function ส่งต่อ event หนึ่งรายการไป project ปลายทาง แล้วบันทึก forward log
async function forwardEvent(requestId: string, destination: string | undefined, event: LineWebhookEvent, secret: string): Promise<void> {
  // พิมพ์ "id" = center-hook ตอบ LINE user id ให้เองก่อน (reply token ใช้ได้ครั้งเดียว) แล้วยังส่งต่อ event ไป webhook default ตามปกติ
  if (pushService.isUserIdRequest(event)) {
    await pushService.replyUserId(event, requestId);
  }

  const target = await webhookService.resolveWebhook(event);
  const targetUrl = target.webhookUrl;
  // ส่งทีละ event และเซ็นใหม่ด้วย secret เดิม ปลายทางจึงตรวจ signature ได้เหมือนรับจาก LINE โดยตรง
  const body = JSON.stringify({ destination, events: [event] });
  const result: ForwardResult = targetUrl
    ? await lineForwardService.forwardToTarget(targetUrl, body, signLineBody(body, secret))
    : {
        status: "SKIPPED",
        http_status: null,
        response_body: null,
        error_message: "No default webhook (smm_app = null) is configured.",
        attempts: 0,
        duration_ms: 0,
        forwarded_at: null,
      };

  if (result.status === "FAILED") {
    logger.warn("Failed to forward LINE event.", { requestId, project: target.logName, eventType: event.type, error: result.error_message });
  }

  // ล้มเหลวติดกัน 5 ครั้ง = แจ้งเตือน LINE / Sentry
  trackForwardResult(target.logName, targetUrl, result);

  await forwardLogRepository.createForwardLog({
    ...result,
    direction: "INBOUND",
    request_id: requestId,
    webhook_event_id: event.webhookEventId ?? null,
    project: target.logName,
    target_url: targetUrl,
    line_user_id: event.source?.userId ?? null,
    event_type: event.type ?? "unknown",
    message_type: event.message?.type ?? null,
    content: truncate(describeEventContent(event), FORWARD_CONFIG.maxContentLength),
    payload: event,
  });
}

// Function ส่งต่อทุก event ของ request ตามลำดับ (event หนึ่งล้มไม่กระทบ event อื่น)
async function forwardEvents(requestId: string, body: LineWebhookBody, secret: string): Promise<void> {
  for (const event of body.events ?? []) {
    try {
      await forwardEvent(requestId, body.destination, event, secret);
    } catch (error) {
      logger.error("Failed to forward or log LINE event.", { requestId, eventType: event.type, error });
      void reportError(error, { source: "forward-line-events", extra: { request_id: requestId, event_type: event.type } });
    }
  }
}

/* -------------------------------------- Functions -------------------------------------- */

// Function รับ LINE webhook ตรวจ signature แล้วส่งต่อ event เบื้องหลัง (ตอบ LINE ทันที)
export function handleLineWebhook(rawBody: string | undefined, signature: string | undefined): { message: string; received: number } {
  const secret = getChannelSecret();
  const body = parseWebhookBody(verifySignature(rawBody, signature, secret));
  const events = Array.isArray(body.events) ? body.events : [];

  if (events.length > 0) {
    const requestId = randomUUID();
    runInBackground("forward-line-events", () => forwardEvents(requestId, { destination: body.destination, events }, secret));
  }

  return { message: "LINE webhook received.", received: events.length };
}
