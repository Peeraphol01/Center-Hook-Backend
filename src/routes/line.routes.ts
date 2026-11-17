// Import Middlewares
import { lineTokenAuth } from "../middlewares/auth.middleware";
// Import Services
import * as pushService from "../services/line/push.service";
import * as inboundService from "../services/line/inbound.service";
// Import Utils
import { createRouter, parseWithSchema, sendJson } from "../utils/api-helper";
// Import Validations
import { linePushBodySchema } from "../validations/push.schema";

const router = createRouter();

/* -------------------------------------- Line Routes -------------------------------------- */

// ขากลับ: LINE ส่ง event มา แล้วส่งต่อไป project ตาม smm_app ในปุ่ม
router.post("/webhook", (c) => {
  return sendJson(c, inboundService.handleLineWebhook(c.get("rawBody"), c.req.header("x-line-signature")));
});

// ขาไป: project ส่งข้อความผ่าน center-hook (ตอบ status และ body ของ LINE ตามจริง)
router.post("/push", lineTokenAuth, async (c) => {
  const body = parseWithSchema(linePushBodySchema, c.get("body"));
  const reply = await pushService.pushMessage(body, c.get("requestId") ?? "unknown");

  return sendJson(c, reply.body, reply.status);
});

export default router;
