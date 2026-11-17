/* -------------------------------------- Types -------------------------------------- */

// Type แถวของ table webhooks
export interface WebhookRecord {
  id: number;
  // null = webhook default
  smm_app: string | null;
  webhook_url: string;
  created_at: string;
  updated_at: string;
}

// Type ส่วน DTO ของ webhook ที่ตอบออก API
export type WebhookDto = WebhookRecord;

// Type ส่วน Repository input สำหรับสร้าง webhook
export interface WebhookCreateInput {
  smm_app: string | null;
  webhook_url: string;
}

// Type ส่วน Repository input สำหรับแก้ webhook (ส่งเฉพาะ field ที่เปลี่ยน)
export type WebhookUpdateInput = Partial<WebhookCreateInput>;

// Type ปลายทางของ event ที่ได้จาก smm_app
export interface ResolvedWebhook {
  // ค่าที่บันทึกในคอลัมน์ project ของ forward log (smm_app ที่ตรง หรือ "default")
  logName: string;
  // null = ไม่มี webhook default ให้ส่ง
  webhookUrl: string | null;
}
