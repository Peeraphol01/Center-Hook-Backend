// Import Middlewares
import { requireAuth, requirePermission } from "../middlewares/auth.middleware";
// Import Services
import * as webhookService from "../services/webhook.service";
// Import Utils
import { createRouter, sendJson } from "../utils/api-helper";

const router = createRouter();

/* -------------------------------------- Webhook Routes -------------------------------------- */

// จัดการ webhook ปลายทาง (smm_app → webhook URL) แก้/ลบอ้างด้วย smm_app ("default" = webhook default)
router.use("*", requireAuth);

router.get("/", requirePermission("webhooks:read"), async (c) => {
  return sendJson(c, await webhookService.listWebhooks());
});

router.post("/", requirePermission("webhooks:create"), async (c) => {
  return sendJson(c, await webhookService.createWebhook(c.get("body")), 201);
});

router.patch("/:smm_app", requirePermission("webhooks:update"), async (c) => {
  return sendJson(c, await webhookService.updateWebhook(c.req.param("smm_app"), c.get("body")));
});

router.delete("/:smm_app", requirePermission("webhooks:delete"), async (c) => {
  return sendJson(c, await webhookService.deleteWebhook(c.req.param("smm_app")));
});

export default router;
