
-- DropForeignKey
ALTER TABLE "user_sessions" DROP CONSTRAINT "user_sessions_account_id_fkey";

-- DropTable
DROP TABLE "accounts";

-- DropTable
DROP TABLE "user_sessions";

