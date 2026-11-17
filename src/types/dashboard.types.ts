// Import Types
import type { ForwardDirection } from "./log.types";

/* -------------------------------------- Types -------------------------------------- */

// Type ความละเอียดของกราฟ (ช่วง 1 วัน = รายชั่วโมง มากกว่านั้น = รายวัน)
export type DashboardInterval = "hour" | "day";

// Type ตัวกรองที่ผ่านการตรวจแล้ว (start/end = ขอบเวลาจริงตาม timezone ของ dashboard)
export interface DashboardFilters {
  start: Date;
  end: Date;
  interval: DashboardInterval;
  timezone: string;
  project?: string;
}

// Type จำนวนแยกตามสถานะ
export interface DashboardStatusCounts {
  total: number;
  success: number;
  failed: number;
  skipped: number;
}

// Type แถวที่ repository นับได้ (จัดกลุ่มตาม project + direction + status)
export interface DashboardGroupRow {
  project: string;
  direction: ForwardDirection;
  status: string;
  count: number;
  duration_sum: number;
}

// Type ส่วน Response GET /api/dashboard
export interface DashboardResponse {
  range: {
    from: string;
    to: string;
    timezone: string;
    interval: DashboardInterval;
    start: string;
    end: string;
  };
  totals: DashboardStatusCounts & {
    // success / (success + failed) | null = ยังไม่มี event ที่ส่งต่อ
    success_rate: number | null;
    inbound: number;
    outbound: number;
    active_line_users: number;
    // เฉลี่ยเฉพาะ SUCCESS/FAILED (SKIPPED ไม่ได้ส่งต่อ)
    avg_duration_ms: number | null;
  };
  timeseries: (DashboardStatusCounts & { bucket: string })[];
  by_project: (DashboardStatusCounts & { project: string; success_rate: number | null; avg_duration_ms: number | null })[];
  recent_failures: {
    id: number;
    project: string;
    direction: ForwardDirection;
    event_type: string;
    line_user_id: string | null;
    http_status: number | null;
    error_message: string | null;
    created_at: string;
  }[];
}
