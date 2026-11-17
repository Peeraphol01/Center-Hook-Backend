// Import Utils
import { logger } from "./logger";
// Import Services
import { reportError } from "../services/error-report.service";

/* -------------------------------------- Config -------------------------------------- */

// Config งานเบื้องหลังที่ยังทำไม่เสร็จ (ใช้รอก่อน shutdown)
const pendingTasks = new Set<Promise<void>>();

/* -------------------------------------- Functions -------------------------------------- */

// Function รันงานเบื้องหลังหลังตอบ request แล้ว (error ไม่หลุดออกมาเป็น unhandled rejection)
export function runInBackground(name: string, task: () => Promise<void>): void {
  const promise = task()
    .catch((error: unknown) => {
      logger.error("Background task failed.", { task: name, error });
      return reportError(error, { source: `background:${name}` });
    })
    .finally(() => pendingTasks.delete(promise));

  pendingTasks.add(promise);
}

// Function รองานเบื้องหลังที่ค้างอยู่ให้เสร็จ ไม่เกิน timeoutMs คืน true ถ้าเสร็จทั้งหมด
export async function waitForBackgroundTasks(timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const finished = (async () => {
    while (pendingTasks.size > 0) {
      await Promise.allSettled([...pendingTasks]);
    }
    return true as const;
  })();

  const result = await Promise.race([finished, timeout]);
  clearTimeout(timer);
  return result;
}
