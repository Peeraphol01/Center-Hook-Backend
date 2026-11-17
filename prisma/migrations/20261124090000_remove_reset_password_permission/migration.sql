-- ยกเลิกสิทธิ์ admins:reset_password (ลบ PATCH /api/admins/{id}/password แล้ว)
DELETE FROM "account_permissions" WHERE "permission" = 'admins:reset_password';
