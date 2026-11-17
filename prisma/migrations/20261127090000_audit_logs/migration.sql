-- CreateTable
CREATE TABLE "audit_logs" (
    "id" BIGSERIAL NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" VARCHAR(100) NOT NULL,
    "result" VARCHAR(20) NOT NULL,
    "severity" VARCHAR(20) NOT NULL DEFAULT 'info',
    "actor_account_id" INTEGER,
    "actor_username" VARCHAR(100),
    "session_id" INTEGER,
    "target_type" VARCHAR(50),
    "target_id" VARCHAR(100),
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "request_id" VARCHAR(255),
    "method" VARCHAR(10),
    "path" VARCHAR(512),
    "metadata" JSONB,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_logs_occurred_at_idx" ON "audit_logs"("occurred_at");
CREATE INDEX "audit_logs_action_occurred_at_idx" ON "audit_logs"("action", "occurred_at");
CREATE INDEX "audit_logs_actor_account_id_occurred_at_idx" ON "audit_logs"("actor_account_id", "occurred_at");
CREATE INDEX "audit_logs_ip_address_occurred_at_idx" ON "audit_logs"("ip_address", "occurred_at");
CREATE INDEX "audit_logs_severity_occurred_at_idx" ON "audit_logs"("severity", "occurred_at");

-- audit log แก้ไขไม่ได้ (append-only) แม้ app ถูกเจาะก็ปลอมประวัติย้อนหลังไม่ได้ / ลบได้เพื่อทำ retention
CREATE OR REPLACE FUNCTION "audit_logs_block_update"() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_logs is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "audit_logs_no_update"
    BEFORE UPDATE ON "audit_logs"
    FOR EACH ROW EXECUTE FUNCTION "audit_logs_block_update"();

-- สิทธิ์ใหม่ audit_logs:read ให้ owner ทุกบัญชี (ให้สิทธิ์ได้เฉพาะคนที่มีสิทธิ์นั้นอยู่แล้ว ถ้าไม่ให้ owner ตอนนี้จะไม่มีใครให้ต่อได้)
INSERT INTO "account_permissions" ("account_id", "permission")
SELECT "id", 'audit_logs:read' FROM "accounts" WHERE "role" = 'owner'
ON CONFLICT ("account_id", "permission") DO NOTHING;
