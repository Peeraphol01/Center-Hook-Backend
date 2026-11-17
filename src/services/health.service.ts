// Import Config
import { prisma } from "../config/database";
// Import Types
import type { HealthStatus } from "../types/health.types";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจสถานะทั้งหมด: process + database (database เชื่อมต่อไม่ได้ = status error)
export async function checkHealth(): Promise<HealthStatus> {
  const startedAt = Date.now();
  let database: HealthStatus["database"] = "ok";

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = "unavailable";
  }

  return {
    status: database === "ok" ? "ok" : "error",
    database,
    database_latency_ms: Date.now() - startedAt,
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}
