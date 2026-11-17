// Import Middlewares
import { requireAuth, requirePermission } from "../middlewares/auth.middleware";
// Import Services
import * as auditService from "../services/audit.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/api-helper";

const router = createRouter();

/* -------------------------------------- Audit Log Routes -------------------------------------- */

// อ่านอย่างเดียว ไม่มี API แก้/ลบ audit log (ลบได้เฉพาะงานลบตามอายุ AUDIT_LOG_RETENTION_DAYS)
router.use("*", requireAuth, requirePermission("audit_logs:read"));

router.get("/", async (c) => {
  return sendJson(c, await auditService.listAuditLogs(getQuery(c)));
});

// สรุปความผิดปกติ (ต้องอยู่ก่อน /:id)
router.get("/security-summary", async (c) => {
  return sendJson(c, await auditService.getSecuritySummary(getQuery(c)));
});

router.get("/:id", async (c) => {
  return sendJson(c, await auditService.getAuditLog(c.req.param("id")));
});

export default router;
