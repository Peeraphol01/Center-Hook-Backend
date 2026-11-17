/* -------------------------------------- Types -------------------------------------- */

// Type ผลการตรวจสถานะของ service (GET /)
export interface HealthStatus {
  status: "ok" | "error";
  database: "ok" | "unavailable";
  database_latency_ms: number;
  uptime_seconds: number;
  timestamp: string;
}
