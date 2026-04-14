-- AlterTable
ALTER TABLE "public"."prompts" ADD COLUMN "friendly_id" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "prompts_friendly_id_key" ON "public"."prompts"("friendly_id");
