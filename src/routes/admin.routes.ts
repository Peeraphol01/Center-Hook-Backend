// Import Middlewares
import { getAuth, requireAuth, requirePermission } from "../middlewares/auth.middleware";
// Import Services
import * as adminService from "../services/admin.service";
// Import Utils
import { createRouter, sendJson } from "../utils/api-helper";

const router = createRouter();

/* -------------------------------------- Admin Routes -------------------------------------- */

// จัดการบัญชีผู้ดูแล: จัดการได้เฉพาะ role ที่ต่ำกว่าตัวเอง และให้ได้เฉพาะสิทธิ์ที่ตัวเองมี (กฎอยู่ใน admin.service)
router.use("*", requireAuth);

router.get("/", requirePermission("admins:read"), async (c) => {
  return sendJson(c, await adminService.listAdmins(getAuth(c)));
});

router.post("/", requirePermission("admins:create"), async (c) => {
  return sendJson(c, await adminService.createAdmin(c.get("body"), getAuth(c)), 201);
});

router.get("/:id", requirePermission("admins:read"), async (c) => {
  return sendJson(c, await adminService.getAdmin(c.req.param("id"), getAuth(c)));
});

router.patch("/:id", requirePermission("admins:update"), async (c) => {
  return sendJson(c, await adminService.updateAdmin(c.req.param("id"), c.get("body"), getAuth(c)));
});

router.patch("/:id/password", requirePermission("admins:reset_password"), async (c) => {
  return sendJson(c, await adminService.resetAdminPassword(c.req.param("id"), c.get("body"), getAuth(c)));
});

router.post("/:id/unlock", requirePermission("admins:update"), async (c) => {
  return sendJson(c, await adminService.unlockAdmin(c.req.param("id"), getAuth(c)));
});

router.delete("/:id", requirePermission("admins:delete"), async (c) => {
  return sendJson(c, await adminService.deleteAdmin(c.req.param("id"), getAuth(c)));
});

export default router;
