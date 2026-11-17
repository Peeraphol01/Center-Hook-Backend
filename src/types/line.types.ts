// Import Validations
import type { z } from "zod";
import type { linePushBodySchema } from "../validations/push.schema";

/* -------------------------------------- Webhook (ขากลับ) -------------------------------------- */

// Type event ของ LINE webhook (เก็บ field อื่นไว้ครบเพื่อส่งต่อแบบไม่ตัดข้อมูล)
export type LineWebhookEvent = {
  type?: string;
  webhookEventId?: string;
  replyToken?: string;
  source?: {
    type?: string;
    userId?: string;
  };
  postback?: {
    data?: string;
  };
  message?: {
    type?: string;
    text?: string;
  };
  [key: string]: unknown;
};

// Type body ของ LINE webhook
export type LineWebhookBody = {
  destination?: string;
  events?: LineWebhookEvent[];
};

// Type ผลการส่งต่อ event ไปปลายทางหนึ่งครั้ง (ใช้ตัดสินว่าจะ retry หรือไม่)
export interface ForwardAttemptResult {
  ok: boolean;
  retryable: boolean;
  http_status: number | null;
  response_body: string | null;
  error_message: string | null;
}

/* -------------------------------------- Push (ขาไป) -------------------------------------- */

// Type body ของ /api/line/push หลัง validate
export type LinePushBody = z.infer<typeof linePushBodySchema>;

// Type ผลจาก LINE API ที่ส่งกลับให้ project ตามจริง (status และ body ของ LINE)
export interface LineApiReply {
  status: number;
  body: unknown;
}
