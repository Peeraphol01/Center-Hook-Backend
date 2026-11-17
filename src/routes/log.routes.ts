// Import Middlewares
import { requireAuth, requirePermission } from "../middlewares/auth.middleware";
// Import Services
import * as forwardLogService from "../services/log.service";
// Import Utils
import { createRouter, getQuery, sendJson } from "../utils/api-helper";

const router = createRouter();

/* -------------------------------------- Forward Log Routes -------------------------------------- */

router.use("*", requireAuth, requirePermission("forward_logs:read"));

router.get("/", async (c) => {
  return sendJson(c, await forwardLogService.listForwardLogs(getQuery(c)));
});

// แชท: log จัดกลุ่มตาม LINE user (ต้องอยู่ก่อน /:id)
router.get("/conversations", async (c) => {
  return sendJson(c, await forwardLogService.listConversations(getQuery(c)));
});

router.get("/conversations/:line_user_id", async (c) => {
  return sendJson(c, await forwardLogService.getConversationLogs(c.req.param("line_user_id"), getQuery(c)));
});

router.get("/:id", async (c) => {
  return sendJson(c, await forwardLogService.getForwardLog(c.req.param("id")));
});

export default router;
