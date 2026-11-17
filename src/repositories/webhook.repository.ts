// Import Library
import type { Webhook } from "@prisma/client";
// Import Config
import { prisma } from "../config/database";
// Import Types
import type { WebhookCreateInput, WebhookRecord, WebhookUpdateInput } from "../types/webhook.types";

/* -------------------------------------- Helpers -------------------------------------- */

// Function แปลง Prisma Webhook เป็น WebhookRecord
function mapWebhook(webhook: Webhook): WebhookRecord {
  return {
    id: webhook.id,
    smm_app: webhook.smmApp,
    webhook_url: webhook.webhookUrl,
    created_at: webhook.createdAt.toISOString(),
    updated_at: webhook.updatedAt.toISOString(),
  };
}

// Function แปลง input เป็น data ของ Prisma (ข้าม field ที่ไม่ได้ส่ง)
function toData(input: WebhookUpdateInput) {
  return {
    ...(input.smm_app !== undefined && { smmApp: input.smm_app }),
    ...(input.webhook_url !== undefined && { webhookUrl: input.webhook_url }),
  };
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง webhook ทั้งหมด เรียงตาม id
export async function listWebhooks(): Promise<WebhookRecord[]> {
  const webhooks = await prisma.webhook.findMany({ orderBy: { id: "asc" } });

  return webhooks.map(mapWebhook);
}

// Function สร้าง webhook (smm_app ซ้ำ Prisma โยน P2002)
export async function createWebhook(input: WebhookCreateInput): Promise<WebhookRecord> {
  const webhook = await prisma.webhook.create({
    data: { smmApp: input.smm_app, webhookUrl: input.webhook_url },
  });

  return mapWebhook(webhook);
}

// Function แก้ webhook (ไม่พบ Prisma โยน P2025, ค่าซ้ำโยน P2002)
export async function updateWebhook(id: number, input: WebhookUpdateInput): Promise<WebhookRecord> {
  return mapWebhook(await prisma.webhook.update({ where: { id }, data: toData(input) }));
}

// Function ลบ webhook คืน true ถ้าลบได้
export async function deleteWebhook(id: number): Promise<boolean> {
  const result = await prisma.webhook.deleteMany({ where: { id } });

  return result.count > 0;
}
