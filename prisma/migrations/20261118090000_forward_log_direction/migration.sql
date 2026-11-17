-- AlterTable
ALTER TABLE "forward_logs" ADD COLUMN "direction" VARCHAR(10) NOT NULL DEFAULT 'INBOUND';
ALTER TABLE "forward_logs" ALTER COLUMN "direction" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "forward_logs_direction_created_at_idx" ON "forward_logs"("direction", "created_at");
