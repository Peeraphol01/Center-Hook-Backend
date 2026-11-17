// Import Library
import { z } from "zod";
// Import Config
import { DASHBOARD_CONFIG } from "../config/app.config";

/* -------------------------------------- Query Schemas -------------------------------------- */

// Schema query ของ GET /api/dashboard
// from/to = วันที่ YYYY-MM-DD ตามเวลาไทย (นับทั้งวัน) ไม่ส่ง to = วันเดียวกับ from | ไม่ส่งทั้งคู่ = วันนี้
export const dashboardQuerySchema = z
  .object({
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
    project: z.string().trim().min(1).max(50).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.to && !query.from) {
      ctx.addIssue({ code: "custom", path: ["from"], message: "from is required when to is provided." });
      return;
    }
    if (!query.from || !query.to) return;

    if (query.to < query.from) {
      ctx.addIssue({ code: "custom", path: ["to"], message: "to must be on or after from." });
      return;
    }

    const days = (Date.parse(query.to) - Date.parse(query.from)) / 86_400_000 + 1;
    if (days > DASHBOARD_CONFIG.maxRangeDays) {
      ctx.addIssue({ code: "custom", path: ["to"], message: `Date range must not exceed ${DASHBOARD_CONFIG.maxRangeDays} days.` });
    }
  });
