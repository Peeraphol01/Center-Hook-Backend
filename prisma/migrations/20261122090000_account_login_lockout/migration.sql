-- ล็อกบัญชีชั่วคราวเมื่อใส่รหัสผิดติดกันเกินกำหนด (นับต่อบัญชี ไม่ขึ้นกับ IP)
ALTER TABLE "accounts" ADD COLUMN "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "locked_until" TIMESTAMP(3);
