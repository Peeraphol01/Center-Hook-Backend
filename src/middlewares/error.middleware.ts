// Import Library
import { HTTPException } from "hono/http-exception";
// Import Types
import type { AppContext } from "../types/app.types";
// Import Utils
import { ApiError, sendJson } from "../utils/api-helper";
import { logger } from "../utils/logger";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตอบ 404 เมื่อไม่พบ route
export function notFoundHandler(c: AppContext): Response {
  return errorHandler(new ApiError(404, "NOT_FOUND", "Route not found."), c);
}

// Function แปลง error ทุกแบบเป็น JSON response (5xx ซ่อนรายละเอียดและเขียน error log)
export function errorHandler(error: unknown, c: AppContext): Response {
  // HTTPException จาก middleware ของ hono มี response สำเร็จรูปอยู่แล้ว
  if (error instanceof HTTPException) {
    c.set("errorCode", `HTTP_${error.status}`);
    return error.getResponse();
  }

  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "INTERNAL_SERVER_ERROR", "Unexpected server error.");
  const requestId = c.get("requestId");

  c.set("errorCode", apiError.code);

  if (apiError.statusCode >= 500) {
    logger.error("Request failed.", { requestId, method: c.req.method, path: c.req.path, error });
  }

  const detailsObject = apiError.details && typeof apiError.details === "object" ? apiError.details : {};

  return sendJson(
    c,
    {
      status_code: apiError.statusCode,
      code: apiError.code,
      message: apiError.message,
      request_id: requestId,
      ...(apiError.statusCode < 500 && detailsObject),
    },
    apiError.statusCode
  );
}
