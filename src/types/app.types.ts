// Import Library
import type { HttpBindings } from "@hono/node-server";
import type { Context } from "hono";
// Import Types
import type { AccessTokenPayload } from "./auth.types";

/* -------------------------------------- Types -------------------------------------- */

// Type ค่าที่ middleware แนบไว้ใน context ของ request
export type AppVariables = {
  // payload ของ access token ที่ผ่าน requireAuth แล้ว
  auth?: AccessTokenPayload;
  body?: unknown;
  rawBody?: string;
  requestId?: string;
  errorCode?: string;
};

// Type environment ของ Hono app (รันบน node:http)
export type AppEnv = { Bindings: HttpBindings; Variables: AppVariables };

// Type context ของ request
export type AppContext = Context<AppEnv>;
