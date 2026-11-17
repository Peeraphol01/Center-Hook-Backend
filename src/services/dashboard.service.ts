// Import Config
import { DASHBOARD_CONFIG } from "../config/app.config";
// Import Repositories
import * as dashboardRepository from "../repositories/dashboard.repository";
// Import Types
import type { DashboardFilters, DashboardGroupRow, DashboardResponse, DashboardStatusCounts } from "../types/dashboard.types";
// Import Utils
import { parseWithSchema } from "../utils/api-helper";
import { addDays, startOfDayIn, todayIn } from "../utils/date";
// Import Validation
import { dashboardQuerySchema } from "../validations/dashboard.schema";

/* -------------------------------------- Helpers -------------------------------------- */

const HOUR_MS = 60 * 60 * 1000;

// Function จำนวนแยกสถานะที่เป็น 0 ทั้งหมด
const emptyCounts = (): DashboardStatusCounts => ({ total: 0, success: 0, failed: 0, skipped: 0 });

// Function บวกจำนวนเข้าช่องของสถานะนั้น
function addCount(target: DashboardStatusCounts, status: string, count: number): void {
  target.total += count;
  if (status === "SUCCESS") target.success += count;
  else if (status === "FAILED") target.failed += count;
  else if (status === "SKIPPED") target.skipped += count;
}

// Function อัตราสำเร็จ = success / (success + failed) ปัด 4 ตำแหน่ง (null = ยังไม่มี event ที่ส่งต่อ)
function successRate(counts: DashboardStatusCounts): number | null {
  const forwarded = counts.success + counts.failed;
  return forwarded === 0 ? null : Math.round((counts.success / forwarded) * 10_000) / 10_000;
}

// Function สรุปกลุ่มที่นับได้: รวมจำนวนตามสถานะ + เวลาเฉลี่ยของ SUCCESS/FAILED
function summarize(rows: DashboardGroupRow[]): DashboardStatusCounts & { success_rate: number | null; avg_duration_ms: number | null } {
  const counts = emptyCounts();
  let forwardedDuration = 0;

  for (const row of rows) {
    addCount(counts, row.status, row.count);
    if (row.status === "SUCCESS" || row.status === "FAILED") forwardedDuration += row.duration_sum;
  }

  const forwarded = counts.success + counts.failed;
  return { ...counts, success_rate: successRate(counts), avg_duration_ms: forwarded === 0 ? null : Math.round(forwardedDuration / forwarded) };
}

// Function เวลาเริ่มของทุกช่องในกราฟ (ช่องที่ไม่มี log ก็ต้องแสดงเป็น 0)
function listBuckets(from: string, to: string, filters: DashboardFilters): Date[] {
  const buckets: Date[] = [];

  if (filters.interval === "hour") {
    for (let time = filters.start.getTime(); time < filters.end.getTime(); time += HOUR_MS) buckets.push(new Date(time));
  } else {
    for (let date = from; date <= to; date = addDays(date, 1)) buckets.push(startOfDayIn(date, filters.timezone));
  }

  return buckets;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function สรุปข้อมูลหน้า Dashboard ตามช่วงวัน (from/to = YYYY-MM-DD ตามเวลาไทย) และ project
export async function getDashboard(query: unknown): Promise<DashboardResponse> {
  const { timezone } = DASHBOARD_CONFIG;
  const parsed = parseWithSchema(dashboardQuerySchema, query);
  const from = parsed.from ?? todayIn(timezone);
  const to = parsed.to ?? from;
  const filters: DashboardFilters = {
    start: startOfDayIn(from, timezone),
    end: startOfDayIn(addDays(to, 1), timezone),
    interval: from === to ? "hour" : "day",
    timezone,
    project: parsed.project,
  };

  const [groups, activeLineUsers, bucketRows, recentFailures] = await Promise.all([
    dashboardRepository.countByGroup(filters),
    dashboardRepository.countActiveLineUsers(filters),
    dashboardRepository.countByBucket(filters),
    dashboardRepository.listRecentFailures(filters),
  ]);

  // totals
  const sumDirection = (direction: string) => groups.filter((row) => row.direction === direction).reduce((sum, row) => sum + row.count, 0);

  // timeseries
  const bucketMap = new Map(listBuckets(from, to, filters).map((bucket) => [bucket.getTime(), { bucket: bucket.toISOString(), ...emptyCounts() }]));
  for (const row of bucketRows) {
    const bucket = bucketMap.get(row.bucket.getTime());
    if (bucket) addCount(bucket, row.status, row.count);
  }

  // by_project (มากไปน้อย)
  const projectRows = new Map<string, DashboardGroupRow[]>();
  for (const row of groups) projectRows.set(row.project, [...(projectRows.get(row.project) ?? []), row]);

  return {
    range: { from, to, timezone, interval: filters.interval, start: filters.start.toISOString(), end: filters.end.toISOString() },
    totals: { ...summarize(groups), inbound: sumDirection("INBOUND"), outbound: sumDirection("OUTBOUND"), active_line_users: activeLineUsers },
    timeseries: [...bucketMap.values()],
    by_project: [...projectRows.entries()]
      .map(([project, rows]) => ({ project, ...summarize(rows) }))
      .sort((a, b) => b.total - a.total || a.project.localeCompare(b.project)),
    recent_failures: recentFailures,
  };
}
