// Import Config
import type { Permission, Role } from "../config/permission.config";

/* -------------------------------------- Types -------------------------------------- */

// Type สถานะบัญชี (inactive = login และใช้ token เดิมไม่ได้)
export type AccountStatus = "active" | "inactive";

// Type ส่วน payload ของ access token (permissions ฝังมาใน token: แก้สิทธิ์แล้ว session ถูก revoke จึงไม่ค้างสิทธิ์เก่า)
export interface AccessTokenPayload {
  token_type: "access";
  account_id: number;
  session_id: number;
  role: Role;
  permissions: Permission[];
  iat?: number;
  exp?: number;
}

// Type ส่วน payload ของ refresh token
export interface RefreshTokenPayload {
  token_type: "refresh";
  account_id: number;
  session_id: number;
  iat?: number;
  exp?: number;
}

// Type แถวของตาราง accounts (มี password_hash ห้ามส่งออก API)
export interface AccountRecord {
  id: number;
  username: string;
  password_hash: string;
  role: Role;
  status: AccountStatus;
  full_name: string;
  failed_login_count: number;
  // ล็อกถึงเวลานี้ (null = ไม่ล็อก) ใช้เทียบกับเวลาปัจจุบัน หมดเวลาแล้วถือว่าไม่ล็อก
  locked_until: string | null;
  created_by: number | null;
  created_at: string;
  updated_at: string;
}

// Type ส่วน DTO ของบัญชีที่ส่งออก API (ไม่มี password_hash และตัวนับรหัสผิด / locked_until เป็น null ถ้าหมดเวลาล็อกแล้ว)
export type AccountDto = Omit<AccountRecord, "password_hash" | "failed_login_count">;

// Type แถวของตาราง user_sessions
export interface SessionRecord {
  id: number;
  account_id: number;
  refresh_token_hash: string;
  is_active: boolean;
  last_active_at: string;
  expires_at: string;
}

// Type ข้อมูล request ที่บันทึกลง session ตอน login
export interface RequestMeta {
  ip_address: string | null;
  user_agent: string | null;
}

// Type ส่วน Response ของ GET /api/auth/me
export interface MeResponse extends AccountDto {
  permissions: Permission[];
}

// Type ส่วน Response ของ token ชุดใหม่ (login / refresh)
export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: "Bearer";
  expires_in: number;
}

// Type ส่วน Response ของ login (แนบ profile มาด้วย ไม่ต้องเรียก /me ซ้ำ)
export interface LoginResponse extends TokenResponse {
  profile: MeResponse;
}
