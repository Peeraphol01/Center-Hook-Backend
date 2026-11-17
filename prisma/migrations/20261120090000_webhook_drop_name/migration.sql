-- ชื่อ webhook ไม่ได้ใช้ในการเลือกปลายทางหรือ log (ใช้ smm_app อย่างเดียว)
ALTER TABLE "webhooks" DROP COLUMN "name";
