// Import Config
import { WEBHOOK_CACHE_MS } from "../config/app.config";
// Import Repositories
import * as webhookRepository from "../repositories/webhook.repository";
// Import Services
import { recordAudit } from "./audit.service";
// Import Types
import type { LineWebhookEvent } from "../types/line.types";
import type { ResolvedWebhook, WebhookDto, WebhookRecord } from "../types/webhook.types";
// Import Utils
import { ApiError, parseWithSchema } from "../utils/api-helper";
// Import Validations
import { webhookCreateBodySchema, webhookSmmAppParamSchema, webhookUpdateBodySchema } from "../validations/webhook.schema";

/* -------------------------------------- Config -------------------------------------- */

// Config key ใน postback data ที่บอกว่าปุ่มเป็นของ project ไหน
export const POSTBACK_APP_KEY = "smm_app";

// Config ชื่อที่บันทึกในคอลัมน์ project ของ forward log เมื่อไปที่ webhook default
const DEFAULT_LOG_NAME = "default";

// Config รายการ webhook ที่ cache ไว้ (event เข้าถี่ ไม่ query DB ทุกครั้ง / แก้ผ่าน API แล้วล้าง cache ทันที)
let webhookCache: { loadedAt: number; webhooks: WebhookRecord[] } | null = null;

/* -------------------------------------- Helpers -------------------------------------- */

// Function ดึง webhook ทั้งหมดผ่าน cache
async function getWebhooks(): Promise<WebhookRecord[]> {
  if (!webhookCache || Date.now() - webhookCache.loadedAt > WEBHOOK_CACHE_MS) {
    webhookCache = { loadedAt: Date.now(), webhooks: await webhookRepository.listWebhooks() };
  }

  return webhookCache.webhooks;
}

// Function อ่านค่า smm_app จาก postback data (event ชนิดอื่นไม่มีค่านี้)
function readPostbackApp(event: LineWebhookEvent): string | null {
  if (event.type !== "postback" || !event.postback?.data) {
    return null;
  }

  return new URLSearchParams(event.postback.data).get(POSTBACK_APP_KEY) || null;
}

// Function แปลง error ของ Prisma เป็น ApiError (ค่าซ้ำ = 409, ไม่พบ = 404)
function toApiError(error: unknown): unknown {
  const code = (error as { code?: unknown })?.code;

  if (code === "P2002") {
    return new ApiError(409, "WEBHOOK_CONFLICT", "smm_app is already used by another webhook.");
  }

  if (code === "P2025") {
    return new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found.");
  }

  return error;
}

// Function ตรวจกฎของ webhook default: มีได้แถวเดียว
async function assertSingleDefault(smmApp: string | null, excludeId?: number): Promise<void> {
  if (smmApp !== null) {
    return;
  }

  webhookCache = null;
  const existingDefault = (await getWebhooks()).find((webhook) => webhook.smm_app === null && webhook.id !== excludeId);

  if (existingDefault) {
    throw new ApiError(409, "DEFAULT_WEBHOOK_EXISTS", `Webhook ${existingDefault.id} is already the default webhook.`);
  }
}

// Function เก็บค่าของ webhook ที่ใช้เทียบก่อน/หลังใน audit log
function snapshotWebhook(webhook: WebhookDto): { smm_app: string | null; webhook_url: string } {
  return { smm_app: webhook.smm_app, webhook_url: webhook.webhook_url };
}

/* -------------------------------------- Routing (ใช้โดย /api/line/webhook และ /api/line/push) -------------------------------------- */

// Function เลือกปลายทางของ event: smm_app ตรงกับ webhook ไหนไปที่นั้น ไม่มีหรือไม่รู้จักไป webhook default
export async function resolveWebhook(event: LineWebhookEvent): Promise<ResolvedWebhook> {
  const app = readPostbackApp(event);
  const webhooks = await getWebhooks();
  const matched = app ? webhooks.find((webhook) => webhook.smm_app === app) : undefined;

  if (matched) {
    return { logName: app as string, webhookUrl: matched.webhook_url };
  }

  return { logName: DEFAULT_LOG_NAME, webhookUrl: webhooks.find((webhook) => webhook.smm_app === null)?.webhook_url ?? null };
}

// Function ตรวจว่า smm_app มีในตาราง webhooks (ใช้กับ /api/line/push: ขาไปต้องระบุ project ที่ลงทะเบียนไว้)
export async function isRegisteredApp(app: string): Promise<boolean> {
  return (await getWebhooks()).some((webhook) => webhook.smm_app === app);
}

// Function ล้าง cache (เรียกหลังแก้ webhook และใช้ใน test)
export function clearWebhookCache(): void {
  webhookCache = null;
}

/* -------------------------------------- CRUD (/api/webhooks) -------------------------------------- */

// Function ดึงรายการ webhook ทั้งหมด
export async function listWebhooks(): Promise<{ data: WebhookDto[] }> {
  return { data: await webhookRepository.listWebhooks() };
}

// Function สร้าง webhook
export async function createWebhook(body: unknown): Promise<WebhookDto> {
  const input = parseWithSchema(webhookCreateBodySchema, body);
  await assertSingleDefault(input.smm_app);

  try {
    const created = await webhookRepository.createWebhook(input);

    recordAudit({ action: "webhook.create", result: "success", target_type: "webhook", target_id: created.id, metadata: { after: snapshotWebhook(created) } });
    return created;
  } catch (error) {
    throw toApiError(error);
  } finally {
    clearWebhookCache();
  }
}

// Function หา webhook จาก smm_app ใน path ("default" = webhook default) ไม่พบตอบ 404
async function findBySmmAppParam(smmAppParam: unknown): Promise<WebhookRecord> {
  const smmApp = parseWithSchema(webhookSmmAppParamSchema, smmAppParam, { message: "Invalid smm_app." });
  const webhook = (await webhookRepository.listWebhooks()).find((item) => item.smm_app === smmApp);

  if (!webhook) {
    throw new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found.");
  }

  return webhook;
}

// Function แก้ webhook ตาม smm_app ใน path (ส่งเฉพาะ field ที่ต้องการเปลี่ยน)
export async function updateWebhook(smmAppParam: unknown, body: unknown): Promise<WebhookDto> {
  const current = await findBySmmAppParam(smmAppParam);
  const input = parseWithSchema(webhookUpdateBodySchema, body);

  await assertSingleDefault(input.smm_app === undefined ? current.smm_app : input.smm_app, current.id);

  try {
    const updated = await webhookRepository.updateWebhook(current.id, input);

    recordAudit({
      action: "webhook.update",
      result: "success",
      target_type: "webhook",
      target_id: current.id,
      metadata: { before: snapshotWebhook(current), after: snapshotWebhook(updated) },
    });
    return updated;
  } catch (error) {
    throw toApiError(error);
  } finally {
    clearWebhookCache();
  }
}

// Function ลบ webhook ตาม smm_app ใน path
export async function deleteWebhook(smmAppParam: unknown): Promise<{ message: string }> {
  const current = await findBySmmAppParam(smmAppParam);
  const deleted = await webhookRepository.deleteWebhook(current.id);
  clearWebhookCache();

  if (!deleted) {
    throw new ApiError(404, "WEBHOOK_NOT_FOUND", "Webhook not found.");
  }

  recordAudit({ action: "webhook.delete", result: "success", target_type: "webhook", target_id: current.id, metadata: { before: snapshotWebhook(current) } });
  return { message: "Webhook deleted." };
}
