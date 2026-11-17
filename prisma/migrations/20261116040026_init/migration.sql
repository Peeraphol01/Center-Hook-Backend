-- CreateTable
CREATE TABLE "accounts" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(512) NOT NULL,
    "role" VARCHAR(20) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'active',
    "full_name" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_sessions" (
    "id" SERIAL NOT NULL,
    "account_id" INTEGER NOT NULL,
    "refresh_token_hash" VARCHAR(512) NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "forward_logs" (
    "id" SERIAL NOT NULL,
    "request_id" VARCHAR(64) NOT NULL,
    "webhook_event_id" VARCHAR(64),
    "project" VARCHAR(50) NOT NULL,
    "target_url" VARCHAR(1024),
    "line_user_id" VARCHAR(64),
    "event_type" VARCHAR(50) NOT NULL,
    "message_type" VARCHAR(50),
    "content" TEXT,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "http_status" INTEGER,
    "response_body" TEXT,
    "error_message" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "forwarded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "forward_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounts_username_key" ON "accounts"("username");

-- CreateIndex
CREATE INDEX "user_sessions_account_id_is_active_idx" ON "user_sessions"("account_id", "is_active");

-- CreateIndex
CREATE INDEX "forward_logs_created_at_idx" ON "forward_logs"("created_at");

-- CreateIndex
CREATE INDEX "forward_logs_status_created_at_idx" ON "forward_logs"("status", "created_at");

-- CreateIndex
CREATE INDEX "forward_logs_project_created_at_idx" ON "forward_logs"("project", "created_at");

-- CreateIndex
CREATE INDEX "forward_logs_line_user_id_created_at_idx" ON "forward_logs"("line_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
