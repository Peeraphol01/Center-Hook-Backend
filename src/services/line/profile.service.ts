// Import Library
import PQueue from "p-queue";
// Import Config
import { LINE_API_CONFIG, LINE_PROFILE_CACHE_MS } from "../../config/app.config";
import { readOptionalEnv } from "../../config/env";
// Import Repositories
import * as lineProfileRepository from "../../repositories/line-profile.repository";
// Import Types
import type { LineProfileDto, LineProfileRecord } from "../../types/line-profile.types";
// Import Utils
import { logger } from "../../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config จำนวน request ไป LINE API พร้อมกัน (หน้าแชทหนึ่งหน้าอาจต้องดึงหลายคนพร้อมกัน)
const profileQueue = new PQueue({ concurrency: 5 });

/* -------------------------------------- Helpers -------------------------------------- */

// Function เลือก endpoint ตามชนิด id (U = user, C = group, R = room ไม่มีโปรไฟล์)
function getProfileUrl(lineUserId: string): string | null {
  const id = encodeURIComponent(lineUserId);

  if (lineUserId.startsWith("U")) return `${LINE_API_CONFIG.profileUrl}/${id}`;
  if (lineUserId.startsWith("C")) return `${LINE_API_CONFIG.groupUrl}/${id}/summary`;

  return null;
}

// Function ดึงโปรไฟล์จาก LINE (เรียกไม่ได้/เครือข่ายล่ม คืน null = ไม่บันทึก ลองใหม่ครั้งหน้า)
async function fetchProfile(lineUserId: string, token: string): Promise<LineProfileRecord | null> {
  const url = getProfileUrl(lineUserId);
  const empty: LineProfileRecord = { line_user_id: lineUserId, display_name: null, picture_url: null, fetched_at: new Date() };

  if (!url) {
    return empty;
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(LINE_API_CONFIG.timeoutMs),
    });

    // 404 = ไม่ใช่เพื่อน/บล็อก OA/ออกจากกลุ่ม: บันทึกว่าไม่มีโปรไฟล์ ไม่ต้องถามซ้ำจนกว่า cache หมดอายุ
    if (response.status === 404) {
      return empty;
    }

    if (!response.ok) {
      logger.warn("Failed to fetch LINE profile.", { lineUserId, status: response.status });
      return null;
    }

    const body = (await response.json()) as { displayName?: string; groupName?: string; pictureUrl?: string };

    return { ...empty, display_name: body.displayName ?? body.groupName ?? null, picture_url: body.pictureUrl ?? null };
  } catch (error) {
    logger.warn("Failed to fetch LINE profile.", { lineUserId, error });
    return null;
  }
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงชื่อ/รูปของหลาย id: ใช้ cache ใน DB ถ้ายังไม่หมดอายุ ไม่งั้นถาม LINE แล้วบันทึก
export async function getProfiles(lineUserIds: string[]): Promise<Map<string, LineProfileDto>> {
  const ids = [...new Set(lineUserIds)];
  const cached = await lineProfileRepository.findByIds(ids);
  const profiles = new Map(cached.map((item) => [item.line_user_id, item]));
  const token = readOptionalEnv("LINE_CHANNEL_ACCESS_TOKEN");
  const staleBefore = Date.now() - LINE_PROFILE_CACHE_MS;
  const toFetch = token ? ids.filter((id) => (profiles.get(id)?.fetched_at.getTime() ?? 0) < staleBefore) : [];

  await Promise.all(
    toFetch.map((id) =>
      profileQueue.add(async () => {
        const fresh = await fetchProfile(id, token!);

        if (fresh) {
          profiles.set(id, fresh);
          await lineProfileRepository.upsertProfile(fresh).catch((error) => logger.warn("Failed to save LINE profile.", { lineUserId: id, error }));
        }
      })
    )
  );

  return new Map(
    ids.map((id) => {
      const profile = profiles.get(id);
      return [id, { display_name: profile?.display_name ?? null, picture_url: profile?.picture_url ?? null }];
    })
  );
}
