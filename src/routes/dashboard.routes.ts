// Import Middlewares
import { requireAuth, requirePermission } from "../middlewares/auth.middleware";
// Import Services
import * as dashboardService from "../services/dashboard.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/api-helper";

const router = createRouter();

/* -------------------------------------- Dashboard Routes -------------------------------------- */

// สรุป forward log ตามช่วงวัน (ข้อมูลมาจาก forward log จึงใช้สิทธิ์ forward_logs:read)
router.use("*", requireAuth, requirePermission("forward_logs:read"));

router.get("/", async (c) => {
  return sendJson(c, await dashboardService.getDashboard(getQuery(c)));
});

export default router;
