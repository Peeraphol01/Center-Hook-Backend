// Import Services
import * as healthService from "../services/health.service";
// Import Utils
import { createRouter, sendJson } from "../utils/api-helper";

const router = createRouter();

/* -------------------------------------- Health Routes -------------------------------------- */

// Route เดียวสำหรับเช็คสถานะทั้งหมด: process + database (ตอบ 503 เมื่อส่วนใดส่วนหนึ่งไม่พร้อม)
router.get("/", async (c) => {
  const health = await healthService.checkHealth();

  return sendJson(c, health, health.status === "ok" ? 200 : 503);
});

export default router;
