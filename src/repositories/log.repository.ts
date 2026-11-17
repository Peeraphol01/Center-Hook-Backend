// Import Library
import type { ForwardLog, Prisma } from "@prisma/client";
// Import Config
import { prisma } from "../config/database";
// Import Types
import type { ConversationFilters, ForwardLogCreateInput, ForwardLogDto, ForwardLogFilters, ForwardLogSummaryDto } from "../types/log.types";

/* -------------------------------------- Helpers -------------------------------------- */

// Function แปลง Prisma ForwardLog เป็น ForwardLogDto
export function mapForwardLog(log: ForwardLog): ForwardLogDto {
  return {
    id: log.id,
    direction: log.direction,
    request_id: log.requestId,
    webhook_event_id: log.webhookEventId,
    project: log.project,
    target_url: log.targetUrl,
    line_user_id: log.lineUserId,
    event_type: log.eventType,
    message_type: log.messageType,
    content: log.content,
    payload: log.payload,
    status: log.status,
    http_status: log.httpStatus,
    response_body: log.responseBody,
    error_message: log.errorMessage,
    attempts: log.attempts,
    duration_ms: log.durationMs,
    forwarded_at: log.forwardedAt?.toISOString() ?? null,
    created_at: log.createdAt.toISOString(),
  };
}

// Function สร้าง Prisma where จาก filters ของ forward log
function buildWhere(filters: ForwardLogFilters): Prisma.ForwardLogWhereInput {
  return {
    direction: filters.direction,
    status: filters.status,
    project: filters.project,
    lineUserId: filters.line_user_id,
    eventType: filters.event_type,
    ...((filters.from || filters.to) && { createdAt: { gte: filters.from, lte: filters.to } }),
  };
}

/* -------------------------------------- Functions -------------------------------------- */

// Function บันทึก forward log หนึ่งรายการ
export async function createForwardLog(input: ForwardLogCreateInput): Promise<void> {
  await prisma.forwardLog.create({
    data: {
      direction: input.direction,
      requestId: input.request_id,
      webhookEventId: input.webhook_event_id,
      project: input.project,
      targetUrl: input.target_url,
      lineUserId: input.line_user_id,
      eventType: input.event_type,
      messageType: input.message_type,
      content: input.content,
      payload: input.payload as Prisma.InputJsonValue,
      status: input.status,
      httpStatus: input.http_status,
      responseBody: input.response_body,
      errorMessage: input.error_message,
      attempts: input.attempts,
      durationMs: input.duration_ms,
      forwardedAt: input.forwarded_at,
    },
  });
}

// Function ค้นหา forward log แบบแบ่งหน้า เรียงจากใหม่ไปเก่า (ไม่ดึง payload/response_body)
export async function listForwardLogs(
  filters: ForwardLogFilters,
  page: number,
  limit: number
): Promise<{ items: ForwardLogSummaryDto[]; total: number }> {
  const where = buildWhere(filters);
  const [items, total] = await Promise.all([
    prisma.forwardLog.findMany({
      where,
      orderBy: { id: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      omit: { payload: true, responseBody: true },
    }),
    prisma.forwardLog.count({ where }),
  ]);

  return {
    items: items.map((item) => {
      const { payload: _payload, response_body: _responseBody, ...summary } = mapForwardLog({ ...item, payload: null, responseBody: null });
      return summary;
    }),
    total,
  };
}

// Function ดึง forward log เต็มรายการจาก id
export async function findForwardLogById(id: number): Promise<ForwardLogDto | null> {
  const log = await prisma.forwardLog.findUnique({ where: { id } });

  return log ? mapForwardLog(log) : null;
}

// Function แปลงแถวที่ไม่ได้ดึง payload/response_body เป็น summary
function toSummary(log: Omit<ForwardLog, "payload" | "responseBody">): ForwardLogSummaryDto {
  const { payload: _payload, response_body: _responseBody, ...summary } = mapForwardLog({ ...log, payload: null, responseBody: null });
  return summary;
}

// Function รายการแชท: จัดกลุ่ม log ตาม LINE user เรียงตามข้อความล่าสุด (ขอเกิน 1 แถวเพื่อรู้ว่ามีหน้าถัดไปไหม)
export async function listConversations(
  filters: ConversationFilters,
  page: number,
  limit: number
): Promise<{ items: { line_user_id: string; log_count: number; last_log: ForwardLogSummaryDto }[]; has_more: boolean }> {
  const where: Prisma.ForwardLogWhereInput = {
    AND: [
      { lineUserId: { not: null } },
      { project: filters.project },
      filters.search
        ? { OR: [{ lineUserId: { contains: filters.search, mode: "insensitive" } }, { lineUserId: { in: filters.search_ids ?? [] } }] }
        : {},
    ],
  };

  const groups = await prisma.forwardLog.groupBy({
    by: ["lineUserId"],
    where,
    _max: { id: true },
    _count: { _all: true },
    orderBy: { _max: { id: "desc" } },
    skip: (page - 1) * limit,
    take: limit + 1,
  });

  const pageGroups = groups.slice(0, limit);
  const lastIds = pageGroups.map((group) => group._max.id).filter((id): id is number => id !== null);
  const lastLogs = await prisma.forwardLog.findMany({ where: { id: { in: lastIds } }, omit: { payload: true, responseBody: true } });
  const lastById = new Map(lastLogs.map((log) => [log.id, toSummary(log)]));

  return {
    items: pageGroups.flatMap((group) => {
      const lastLog = group._max.id === null ? undefined : lastById.get(group._max.id);
      return group.lineUserId && lastLog ? [{ line_user_id: group.lineUserId, log_count: group._count._all, last_log: lastLog }] : [];
    }),
    has_more: groups.length > limit,
  };
}

// Function ข้อความในแชทของ LINE user หนึ่งคน (ใหม่ไปเก่า มี payload ไว้แสดงข้อความ ไม่มี response_body)
export async function listConversationLogs(
  lineUserId: string,
  filters: { project?: string; before_id?: number },
  limit: number
): Promise<{ items: Omit<ForwardLogDto, "response_body">[]; has_more: boolean }> {
  const rows = await prisma.forwardLog.findMany({
    where: { lineUserId, project: filters.project, ...(filters.before_id && { id: { lt: filters.before_id } }) },
    orderBy: { id: "desc" },
    take: limit + 1,
    omit: { responseBody: true },
  });

  return {
    items: rows.slice(0, limit).map((row) => {
      const { response_body: _responseBody, ...log } = mapForwardLog({ ...row, responseBody: null });
      return log;
    }),
    has_more: rows.length > limit,
  };
}

// Function ลบ forward log ที่เก่ากว่าเวลาที่กำหนด คืนจำนวนที่ลบ
export async function deleteForwardLogsBefore(before: Date): Promise<number> {
  const result = await prisma.forwardLog.deleteMany({ where: { createdAt: { lt: before } } });

  return result.count;
}
