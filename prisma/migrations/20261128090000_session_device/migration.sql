-- 1 บัญชีใช้ได้ 1 เครื่อง: เก็บรหัสเครื่องของ session และเหตุที่ถูก revoke (replaced = ถูกเครื่องอื่นเตะออก)
ALTER TABLE "user_sessions" ADD COLUMN "device_id" VARCHAR(128),
ADD COLUMN "revoke_reason" VARCHAR(32);
