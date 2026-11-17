
-- CreateTable
CREATE TABLE "webhooks" (
    "id" SERIAL NOT NULL,
    "smm_app" VARCHAR(50),
    "name" VARCHAR(100) NOT NULL,
    "webhook_url" VARCHAR(1024) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "webhooks_smm_app_key" ON "webhooks"("smm_app");
