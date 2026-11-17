// Import Middlewares
import { getAuth, requireAuth } from "../middlewares/auth.middleware";
// Import Services
import * as authService from "../services/auth.service";
// Import Utils
import { createRouter, getClientIp, sendJson } from "../utils/api-helper";

const router = createRouter();

/* -------------------------------------- Auth Routes -------------------------------------- */

router.post("/login", async (c) => {
  const meta = { ip_address: getClientIp(c), user_agent: c.req.header("user-agent") ?? null };

  return sendJson(c, await authService.login(c.get("body"), meta));
});

router.post("/refresh", async (c) => {
  return sendJson(c, await authService.refresh(c.get("body")));
});

router.post("/logout", requireAuth, async (c) => {
  return sendJson(c, await authService.logout(getAuth(c)));
});

router.get("/me", requireAuth, async (c) => {
  return sendJson(c, await authService.me(getAuth(c)));
});

router.patch("/me/password", requireAuth, async (c) => {
  return sendJson(c, await authService.changeOwnPassword(getAuth(c), c.get("body")));
});

export default router;
