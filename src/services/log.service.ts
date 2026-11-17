// Import Config
import { FORWARD_LOG_RETENTION_DAYS } from "../config/app.config";
// Import Repositories
import * as forwardLogRepository from "../repositories/log.repository";
import * as lineProfileRepository from "../repositories/line-profile.repository";
// Import Services
import * as lineProfileService from "./line/profile.service";
// Import Types
import type { ConversationListResponse, ConversationLogsResponse, ForwardLogDto, ForwardLogListResponse } from "../types/log.types";
// Import Validation
import { ApiError, parseWithSchema } from "../utils/api-helper";
import {
  conversationListQuerySchema,
  conversationLogsQuerySchema,
  forwardLogListQuerySchema,
  idParamSchema,
  lineUserIdParamSchema,
} from "../validations/log.schema";
// Import Utils

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา forward log แบบแบ่งหน้าตาม filter
export async function listForwardLogs(query: unknown): Promise<ForwardLogListResponse> {
  const { page, limit, ...filters } = parseWithSchema(forwardLogListQuerySchema, query);
  const { items, total } = await forwardLogRepository.listForwardLogs(filters, page, limit);

  return {
    data: items,
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

// Function ดึง forward log หนึ่งรายการพร้อม payload เต็ม
export async function getForwardLog(id: unknown): Promise<ForwardLogDto> {
  const logId = parseWithSchema(idParamSchema, id, { message: "Invalid id." });
  const log = await forwardLogRepository.findForwardLogById(logId);

  if (!log) {
    throw new ApiError(404, "FORWARD_LOG_NOT_FOUND", "Forward log not found.");
  }

  return log;
}

// Function รายการแชท (log จัดกลุ่มตาม LINE user) พร้อมชื่อ/รูปโปรไฟล์ LINE
export async function listConversations(query: unknown): Promise<ConversationListResponse> {
  const { page, limit, project, search } = parseWithSchema(conversationListQuerySchema, query);
  const searchIds = search ? await lineProfileRepository.findIdsByDisplayName(search) : undefined;
  const { items, has_more } = await forwardLogRepository.listConversations({ project, search, search_ids: searchIds }, page, limit);
  const profiles = await lineProfileService.getProfiles(items.map((item) => item.line_user_id));

  return {
    data: items.map((item) => ({ ...item, profile: profiles.get(item.line_user_id)! })),
    pagination: { page, limit, has_more },
  };
}

// Function ข้อความในแชทของ LINE user หนึ่งคน (ใหม่ไปเก่า โหลดย้อนหลังด้วย before_id)
export async function getConversationLogs(lineUserIdParam: unknown, query: unknown): Promise<ConversationLogsResponse> {
  const lineUserId = parseWithSchema(lineUserIdParamSchema, lineUserIdParam, { message: "Invalid LINE user id." });
  const { limit, ...filters } = parseWithSchema(conversationLogsQuerySchema, query);
  const [{ items, has_more }, profiles] = await Promise.all([
    forwardLogRepository.listConversationLogs(lineUserId, filters, limit),
    lineProfileService.getProfiles([lineUserId]),
  ]);

  return { line_user_id: lineUserId, profile: profiles.get(lineUserId)!, data: items, has_more };
}

// Function ลบ forward log ที่เก่ากว่าอายุที่กำหนด คืนจำนวนที่ลบ
export async function deleteExpiredForwardLogs(): Promise<number> {
  const before = new Date(Date.now() - FORWARD_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);

  return forwardLogRepository.deleteForwardLogsBefore(before);
}
