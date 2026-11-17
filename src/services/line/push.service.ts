// Import Config
import { FORWARD_CONFIG, LINE_API_CONFIG } from "../../config/app.config";
import { readOptionalEnv } from "../../config/env";
// Import Repositories
import * as forwardLogRepository from "../../repositories/log.repository";
// Import Services
import * as webhookService from "../webhook.service";
// Import Utils
import { truncate } from "../../utils/text";
// Import Types
import type { ForwardStatus } from "../../types/log.types";
import type { LineApiReply, LinePushBody, LineWebhookEvent } from "../../types/line.types";
// Import Utils
import { ApiError } from "../../utils/api-helper";
import { logger } from "../../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config ข้อความที่ผู้ใช้พิมพ์เพื่อขอ LINE user id ของตัวเอง และชื่อที่บันทึกในคอลัมน์ project ของ log ตอบกลับ
// ("id" ไม่มี smm_app จึงนับเป็น default เหมือน event ขาเข้าที่ทำให้เกิดการตอบนี้)
const USER_ID_COMMAND = "id";
const USER_ID_REPLY_LOG_NAME = "default";

/* -------------------------------------- Helpers -------------------------------------- */

// Function อ่าน channel access token (ไม่ตั้งตอบ 503)
function getAccessToken(): string {
  const token = readOptionalEnv("LINE_CHANNEL_ACCESS_TOKEN");

  if (!token) {
    throw new ApiError(503, "LINE_PUSH_NOT_CONFIGURED", "LINE_CHANNEL_ACCESS_TOKEN is not configured.");
  }

  return token;
}

// Function อ่าน body ของ response เป็น JSON (ไม่ใช่ JSON คืนเป็น { message })
async function readResponseBody(response: Response): Promise<{ text: string; body: unknown }> {
  const text = await response.text().catch(() => "");

  try {
    return { text, body: text ? JSON.parse(text) : {} };
  } catch {
    return { text, body: { message: text } };
  }
}

// Function สรุปเนื้อหาข้อความสำหรับเก็บใน log (altText ของ Flex หรือ text ของข้อความธรรมดา)
function describeMessages(messages: Record<string, unknown>[]): string {
  return messages
    .map((message) => (typeof message.altText === "string" && message.altText)
      || (typeof message.text === "string" && message.text)
      || `[${String(message.type ?? "unknown")}]`)
    .join(" | ");
}

// Function บันทึก log ขาไป (log พังต้องไม่ทำให้การส่งพัง)
async function saveOutboundLog(input: {
  requestId: string;
  project: string;
  eventType: "push" | "reply";
  targetUrl: string;
  lineUserId: string;
  messages: Record<string, unknown>[];
  payload: Record<string, unknown>;
  status: ForwardStatus;
  httpStatus: number | null;
  responseBody: string | null;
  errorMessage: string | null;
  durationMs: number;
}): Promise<void> {
  try {
    await forwardLogRepository.createForwardLog({
      direction: "OUTBOUND",
      request_id: input.requestId,
      webhook_event_id: null,
      project: input.project,
      target_url: input.targetUrl,
      line_user_id: input.lineUserId,
      event_type: input.eventType,
      message_type: String(input.messages[0]?.type ?? "unknown"),
      content: truncate(describeMessages(input.messages), FORWARD_CONFIG.maxContentLength),
      payload: input.payload,
      status: input.status,
      http_status: input.httpStatus,
      response_body: truncate(input.responseBody, FORWARD_CONFIG.maxResponseBodyLength),
      error_message: input.errorMessage,
      attempts: 1,
      duration_ms: input.durationMs,
      forwarded_at: new Date(),
    });
  } catch (error) {
    logger.error("Failed to save outbound LINE log.", { requestId: input.requestId, project: input.project, error });
  }
}

// Function แปลง error ของ fetch เป็นข้อความสำหรับ log
function describeFetchError(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `Timeout after ${LINE_API_CONFIG.timeoutMs}ms`;
  }

  return error instanceof Error ? error.message : String(error);
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ส่ง push message ไป LINE แทน project แล้วบันทึก log ขาไป
// ส่งครั้งเดียวไม่ retry เอง (project เป็นคน retry ด้วย retry_key เดิม) และคืน status/body ของ LINE ตามจริง
export async function pushMessage(push: LinePushBody, requestId: string): Promise<LineApiReply> {
  if (!(await webhookService.isRegisteredApp(push.smm_app))) {
    throw new ApiError(400, "UNKNOWN_SMM_APP", `smm_app "${push.smm_app}" is not registered in /api/webhooks.`);
  }

  const token = getAccessToken();
  const startedAt = Date.now();
  const log = {
    requestId,
    project: push.smm_app,
    eventType: "push" as const,
    targetUrl: LINE_API_CONFIG.pushUrl,
    lineUserId: push.to,
    messages: push.messages,
    payload: { to: push.to, messages: push.messages },
  };
  let response: Response;

  try {
    response = await fetch(LINE_API_CONFIG.pushUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        ...(push.retry_key ? { "x-line-retry-key": push.retry_key } : {}),
      },
      body: JSON.stringify({ to: push.to, messages: push.messages }),
      signal: AbortSignal.timeout(LINE_API_CONFIG.timeoutMs),
    });
  } catch (error) {
    const message = describeFetchError(error);

    await saveOutboundLog({ ...log, status: "FAILED", httpStatus: null, responseBody: null, errorMessage: message, durationMs: Date.now() - startedAt });
    throw new ApiError(502, "LINE_API_UNAVAILABLE", `LINE API request failed: ${message}`);
  }

  const { text, body } = await readResponseBody(response);
  // 409 พร้อม retry key = LINE รับข้อความนี้ไปแล้วจากรอบก่อน ถือว่าส่งสำเร็จ
  const delivered = response.ok || (response.status === 409 && Boolean(push.retry_key));

  await saveOutboundLog({
    ...log,
    status: delivered ? "SUCCESS" : "FAILED",
    httpStatus: response.status,
    responseBody: text || null,
    errorMessage: delivered ? null : `HTTP ${response.status}`,
    durationMs: Date.now() - startedAt,
  });

  return { status: response.status, body };
}

// Function ตรวจว่า event เป็นข้อความ "id" ที่ขอ LINE user id (ไม่สนตัวพิมพ์เล็กใหญ่และช่องว่างหัวท้าย)
export function isUserIdRequest(event: LineWebhookEvent): boolean {
  return (
    event.type === "message" &&
    event.message?.type === "text" &&
    event.message.text?.trim().toLowerCase() === USER_ID_COMMAND &&
    Boolean(event.replyToken) &&
    Boolean(event.source?.userId)
  );
}

// Function ตอบ LINE user id กลับในแชทผ่าน Reply API (ไม่นับโควต้า) ใช้ช่วยตั้งค่าทดสอบของทุก project
// error ทุกชนิดแค่บันทึก log ไม่ throw เพื่อให้ event ยังถูกส่งต่อไป webhook default ตามปกติ
export async function replyUserId(event: LineWebhookEvent, requestId: string): Promise<void> {
  const token = readOptionalEnv("LINE_CHANNEL_ACCESS_TOKEN");
  const lineUserId = event.source?.userId as string;

  if (!token) {
    logger.warn("Skipped LINE user id reply: LINE_CHANNEL_ACCESS_TOKEN is not configured.", { requestId });
    return;
  }

  const messages = [{ type: "text", text: `Your user ID: ${lineUserId}` }];
  const log = {
    requestId,
    project: USER_ID_REPLY_LOG_NAME,
    eventType: "reply" as const,
    targetUrl: LINE_API_CONFIG.replyUrl,
    lineUserId,
    messages,
    payload: { messages },
  };
  const startedAt = Date.now();

  try {
    const response = await fetch(LINE_API_CONFIG.replyUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ replyToken: event.replyToken, messages }),
      signal: AbortSignal.timeout(LINE_API_CONFIG.timeoutMs),
    });
    const { text } = await readResponseBody(response);

    await saveOutboundLog({
      ...log,
      status: response.ok ? "SUCCESS" : "FAILED",
      httpStatus: response.status,
      responseBody: text || null,
      errorMessage: response.ok ? null : `HTTP ${response.status}`,
      durationMs: Date.now() - startedAt,
    });
  } catch (error) {
    await saveOutboundLog({ ...log, status: "FAILED", httpStatus: null, responseBody: null, errorMessage: describeFetchError(error), durationMs: Date.now() - startedAt });
  }
}
