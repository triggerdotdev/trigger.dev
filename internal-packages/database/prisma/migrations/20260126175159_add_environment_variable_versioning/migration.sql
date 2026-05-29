-- AlterTable
ALTER TABLE "public"."EnvironmentVariableValue" ADD COLUMN     "lastUpdatedBy" JSONB,
ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;
