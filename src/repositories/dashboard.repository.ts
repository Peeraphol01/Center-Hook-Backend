// Import Library
import type { Prisma } from "@prisma/client";
// Import Config
import { DASHBOARD_CONFIG } from "../config/app.config";
import { prisma } from "../config/database";
// Import Types
import type { DashboardFilters, DashboardGroupRow, DashboardResponse } from "../types/dashboard.types";
import type { ForwardDirection } from "../types/log.types";

/* -------------------------------------- Helpers -------------------------------------- */

// Function where ของ Prisma (ช่วงเวลา [start, end) และ project)
function buildWhere(filters: DashboardFilters): Prisma.ForwardLogWhereInput {
  return { createdAt: { gte: filters.start, lt: filters.end }, project: filters.project };
}

// Function แปลง Date เป็นค่าที่เทียบกับ created_at ได้ (created_at เก็บเวลา UTC แบบไม่มี timezone)
const utc = (date: Date) => date.toISOString();

/* -------------------------------------- Functions -------------------------------------- */

// Function นับ log จัดกลุ่มตาม project + direction + status พร้อมผลรวม duration (ใช้คำนวณ totals และ by_project)
export async function countByGroup(filters: DashboardFilters): Promise<DashboardGroupRow[]> {
  const groups = await prisma.forwardLog.groupBy({
    by: ["project", "direction", "status"],
    where: buildWhere(filters),
    _count: { _all: true },
    _sum: { durationMs: true },
  });

  return groups.map((group) => ({
    project: group.project,
    direction: group.direction as ForwardDirection,
    status: group.status,
    count: group._count._all,
    duration_sum: group._sum.durationMs ?? 0,
  }));
}

// Function นับจำนวน LINE user ที่มี log ในช่วงเวลา (ไม่ซ้ำคน)
export async function countActiveLineUsers(filters: DashboardFilters): Promise<number> {
  const project = filters.project ?? null;
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(DISTINCT "line_user_id")::int AS "count"
    FROM "forward_logs"
    WHERE "created_at" >= (${utc(filters.start)}::timestamptz AT TIME ZONE 'UTC')
      AND "created_at" < (${utc(filters.end)}::timestamptz AT TIME ZONE 'UTC')
      AND (${project}::text IS NULL OR "project" = ${project})`;

  return Number(rows[0]?.count ?? 0);
}

// Function นับ log ตามช่วงเวลา (รายชั่วโมง/รายวัน ตัดตาม timezone ของ dashboard) แยก status
export async function countByBucket(filters: DashboardFilters): Promise<{ bucket: Date; status: string; count: number }[]> {
  const project = filters.project ?? null;
  const rows = await prisma.$queryRaw<{ bucket: Date; status: string; count: number }[]>`
    SELECT
      date_trunc(${filters.interval}, ("created_at" AT TIME ZONE 'UTC') AT TIME ZONE ${filters.timezone}) AT TIME ZONE ${filters.timezone} AS "bucket",
      "status",
      COUNT(*)::int AS "count"
    FROM "forward_logs"
    WHERE "created_at" >= (${utc(filters.start)}::timestamptz AT TIME ZONE 'UTC')
      AND "created_at" < (${utc(filters.end)}::timestamptz AT TIME ZONE 'UTC')
      AND (${project}::text IS NULL OR "project" = ${project})
    GROUP BY 1, 2`;

  return rows.map((row) => ({ bucket: new Date(row.bucket), status: row.status, count: Number(row.count) }));
}

// Function log ที่ส่งไม่สำเร็จล่าสุด
export async function listRecentFailures(filters: DashboardFilters): Promise<DashboardResponse["recent_failures"]> {
  const rows = await prisma.forwardLog.findMany({
    where: { ...buildWhere(filters), status: "FAILED" },
    orderBy: { id: "desc" },
    take: DASHBOARD_CONFIG.recentFailuresLimit,
    select: { id: true, project: true, direction: true, eventType: true, lineUserId: true, httpStatus: true, errorMessage: true, createdAt: true },
  });

  return rows.map((row) => ({
    id: row.id,
    project: row.project,
    direction: row.direction as ForwardDirection,
    event_type: row.eventType,
    line_user_id: row.lineUserId,
    http_status: row.httpStatus,
    error_message: row.errorMessage,
    created_at: row.createdAt.toISOString(),
  }));
}
