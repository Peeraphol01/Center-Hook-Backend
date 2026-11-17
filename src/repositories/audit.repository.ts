// Import Library
import type { AuditLog, Prisma } from "@prisma/client";
// Import Config
import { prisma } from "../config/database";
// Import Types
import type { AuditAction, AuditLogCreateInput, AuditLogDto, AuditLogFilters, AuditResult, AuditSeverity } from "../types/audit.types";

/* -------------------------------------- Helpers -------------------------------------- */

// Function แปลง Prisma AuditLog เป็น AuditLogDto (id เป็น BigInt ส่งออกเป็น string)
function mapAuditLog(log: AuditLog): AuditLogDto {
  return {
    id: log.id.toString(),
    occurred_at: log.occurredAt.toISOString(),
    action: log.action as AuditAction,
    result: log.result as AuditResult,
    severity: log.severity as AuditSeverity,
    actor_account_id: log.actorAccountId,
    actor_username: log.actorUsername,
    session_id: log.sessionId,
    target_type: log.targetType,
    target_id: log.targetId,
    ip_address: log.ipAddress,
    geo_country: log.geoCountry,
    geo_city: log.geoCity,
    user_agent: log.userAgent,
    request_id: log.requestId,
    method: log.method,
    path: log.path,
    metadata: (log.metadata as Record<string, unknown> | null) ?? null,
  };
}

// Function สร้าง Prisma where จาก filters
function buildWhere(filters: AuditLogFilters): Prisma.AuditLogWhereInput {
  return {
    AND: [
      {
        result: filters.result,
        severity: filters.severity,
        actorAccountId: filters.actor_account_id,
        actorUsername: filters.actor_username,
        ipAddress: filters.ip_address,
        targetType: filters.target_type,
        targetId: filters.target_id,
        requestId: filters.request_id,
        ...((filters.from || filters.to) && { occurredAt: { gte: filters.from, lte: filters.to } }),
      },
      filters.action ? { action: filters.action } : {},
      filters.action_prefix ? { action: { startsWith: filters.action_prefix } } : {},
    ],
  };
}

/* -------------------------------------- Functions -------------------------------------- */

// Function บันทึก audit log หนึ่งรายการ (ตัดความยาวตามคอลัมน์)
export async function createAuditLog(input: AuditLogCreateInput): Promise<void> {
  await prisma.auditLog.create({
    data: {
      action: input.action,
      result: input.result,
      severity: input.severity,
      actorAccountId: input.actor_account_id,
      actorUsername: input.actor_username?.slice(0, 100) ?? null,
      sessionId: input.session_id,
      targetType: input.target_type?.slice(0, 50) ?? null,
      targetId: input.target_id?.slice(0, 100) ?? null,
      ipAddress: input.ip_address?.slice(0, 64) ?? null,
      geoCountry: input.geo_country?.slice(0, 2) ?? null,
      geoCity: input.geo_city?.slice(0, 100) ?? null,
      userAgent: input.user_agent?.slice(0, 512) ?? null,
      requestId: input.request_id?.slice(0, 255) ?? null,
      method: input.method?.slice(0, 10) ?? null,
      path: input.path?.slice(0, 512) ?? null,
      metadata: (input.metadata ?? undefined) as Prisma.InputJsonValue | undefined,
    },
  });
}

// Function ค้นหา audit log แบบแบ่งหน้า เรียงจากใหม่ไปเก่า
export async function listAuditLogs(filters: AuditLogFilters, page: number, limit: number): Promise<{ items: AuditLogDto[]; total: number }> {
  const where = buildWhere(filters);
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({ where, orderBy: { id: "desc" }, skip: (page - 1) * limit, take: limit }),
    prisma.auditLog.count({ where }),
  ]);

  return { items: items.map(mapAuditLog), total };
}

// Function ดึง audit log ตาม id
export async function findAuditLogById(id: bigint): Promise<AuditLogDto | null> {
  const log = await prisma.auditLog.findUnique({ where: { id } });

  return log ? mapAuditLog(log) : null;
}

// Function นับจำนวนเหตุการณ์แยกตาม action ในช่วงเวลา
export async function countByAction(from: Date, to: Date): Promise<{ action: string; count: number }[]> {
  const groups = await prisma.auditLog.groupBy({
    by: ["action"],
    where: { occurredAt: { gte: from, lte: to } },
    _count: { _all: true },
    orderBy: { _count: { action: "desc" } },
  });

  return groups.map((group) => ({ action: group.action, count: group._count._all }));
}

// Function อันดับค่าของคอลัมน์ (IP หรือ username) ที่เกิด action ที่ระบุบ่อยที่สุดในช่วงเวลา
export async function topValuesForActions(
  field: "ipAddress" | "actorUsername",
  actions: readonly AuditAction[],
  from: Date,
  to: Date,
  take: number
): Promise<{ value: string; count: number }[]> {
  const groups = await prisma.auditLog.groupBy({
    by: [field],
    where: { action: { in: [...actions] }, occurredAt: { gte: from, lte: to }, [field]: { not: null } },
    _count: { _all: true },
    orderBy: { _count: { [field]: "desc" } },
    take,
  });

  return groups.flatMap((group) => {
    const value = group[field];
    return value ? [{ value, count: group._count._all }] : [];
  });
}

// Function ดึงเหตุการณ์ที่มีความรุนแรงตามที่ระบุล่าสุด
export async function listRecentBySeverity(severities: readonly AuditSeverity[], from: Date, to: Date, take: number): Promise<AuditLogDto[]> {
  const items = await prisma.auditLog.findMany({
    where: { severity: { in: [...severities] }, occurredAt: { gte: from, lte: to } },
    orderBy: { id: "desc" },
    take,
  });

  return items.map(mapAuditLog);
}

// Function ลบ audit log ที่เก่ากว่าเวลาที่กำหนด คืนจำนวนที่ลบ
export async function deleteAuditLogsBefore(before: Date): Promise<number> {
  const result = await prisma.auditLog.deleteMany({ where: { occurredAt: { lt: before } } });

  return result.count;
}
