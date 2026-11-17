// Import Types
import type { LineProfileDto } from "./line-profile.types";

/* -------------------------------------- Types -------------------------------------- */

// Type สถานะของการส่งต่อ event
export type ForwardStatus = "SUCCESS" | "FAILED" | "SKIPPED";

// Type ทิศทางของ log (INBOUND = LINE ส่ง event มาแล้วส่งต่อให้ project, OUTBOUND = project ส่งข้อความผ่าน center-hook ไป LINE)
export type ForwardDirection = "INBOUND" | "OUTBOUND";

// Type ผลการส่ง HTTP ไปปลายทาง (รวมทุก attempt)
export interface ForwardResult {
  status: ForwardStatus;
  http_status: number | null;
  response_body: string | null;
  error_message: string | null;
  attempts: number;
  duration_ms: number;
  forwarded_at: Date | null;
}

// Type ส่วน Repository input สำหรับบันทึก forward log
export interface ForwardLogCreateInput extends ForwardResult {
  direction: ForwardDirection;
  request_id: string;
  webhook_event_id: string | null;
  project: string;
  target_url: string | null;
  line_user_id: string | null;
  event_type: string;
  message_type: string | null;
  content: string | null;
  payload: unknown;
}

// Type ส่วน DTO ของ table forward_logs
export interface ForwardLogDto {
  id: number;
  direction: string;
  request_id: string;
  webhook_event_id: string | null;
  project: string;
  target_url: string | null;
  line_user_id: string | null;
  event_type: string;
  message_type: string | null;
  content: string | null;
  payload: unknown;
  status: string;
  http_status: number | null;
  response_body: string | null;
  error_message: string | null;
  attempts: number;
  duration_ms: number;
  forwarded_at: string | null;
  created_at: string;
}

// Type ส่วน DTO ของ forward log ในหน้ารายการ (ไม่มี payload/response_body)
export type ForwardLogSummaryDto = Omit<ForwardLogDto, "payload" | "response_body">;

// Type ส่วน Filters ของการค้นหา forward log
export interface ForwardLogFilters {
  direction?: ForwardDirection;
  status?: ForwardStatus;
  project?: string;
  line_user_id?: string;
  event_type?: string;
  from?: Date;
  to?: Date;
}

// Type ส่วน Response ของ API รายการ forward log
export interface ForwardLogListResponse {
  data: ForwardLogSummaryDto[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface ConversationFilters {
  project?: string;
  // ค้นหาจาก LINE user id (บางส่วน) หรือชื่อโปรไฟล์ (search_ids = id ที่ชื่อตรง)
  search?: string;
  search_ids?: string[];
}

export interface ConversationListItem {
  line_user_id: string;
  profile: LineProfileDto;
  log_count: number;
  last_log: ForwardLogSummaryDto;
}

export interface ConversationListResponse {
  data: ConversationListItem[];
  pagination: { page: number; limit: number; has_more: boolean };
}

export interface ConversationLogsResponse {
  line_user_id: string;
  profile: LineProfileDto;
  // ใหม่ไปเก่า ส่ง before_id = id ตัวสุดท้ายเพื่อโหลดข้อความก่อนหน้า
  data: Omit<ForwardLogDto, "response_body">[];
  has_more: boolean;
}
