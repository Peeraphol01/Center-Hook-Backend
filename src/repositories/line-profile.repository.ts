// Import Config
import { prisma } from "../config/database";
// Import Types
import type { LineProfileRecord } from "../types/line-profile.types";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงโปรไฟล์ที่ cache ไว้ตามรายการ id
export async function findByIds(lineUserIds: string[]): Promise<LineProfileRecord[]> {
  if (lineUserIds.length === 0) {
    return [];
  }

  const rows = await prisma.lineProfile.findMany({ where: { lineUserId: { in: lineUserIds } } });

  return rows.map((row) => ({
    line_user_id: row.lineUserId,
    display_name: row.displayName,
    picture_url: row.pictureUrl,
    fetched_at: row.fetchedAt,
  }));
}

// Function ค้นหา id จากชื่อ (ไม่สนตัวพิมพ์เล็กใหญ่ จำกัดจำนวนกัน query ใหญ่เกิน)
export async function findIdsByDisplayName(search: string, take = 200): Promise<string[]> {
  const rows = await prisma.lineProfile.findMany({
    where: { displayName: { contains: search, mode: "insensitive" } },
    select: { lineUserId: true },
    take,
  });

  return rows.map((row) => row.lineUserId);
}

// Function บันทึก/อัปเดตโปรไฟล์ที่ดึงจาก LINE
export async function upsertProfile(profile: LineProfileRecord): Promise<void> {
  const data = { displayName: profile.display_name, pictureUrl: profile.picture_url, fetchedAt: profile.fetched_at };

  await prisma.lineProfile.upsert({
    where: { lineUserId: profile.line_user_id },
    create: { lineUserId: profile.line_user_id, ...data },
    update: data,
  });
}
