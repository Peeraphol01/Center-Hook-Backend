-- CreateTable
CREATE TABLE "line_profiles" (
    "line_user_id" VARCHAR(64) NOT NULL,
    "display_name" VARCHAR(255),
    "picture_url" VARCHAR(1024),
    "fetched_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "line_profiles_pkey" PRIMARY KEY ("line_user_id")
);

