-- AlterTable
ALTER TABLE "public"."llm_models" ADD COLUMN     "capabilities" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "context_window" INTEGER,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "is_hidden" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "max_output_tokens" INTEGER,
ADD COLUMN     "provider" TEXT;
