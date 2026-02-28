-- AlterTable
ALTER TABLE "public"."EventDefinition" ADD COLUMN     "compatibleVersions" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "deprecatedAt" TIMESTAMP(3),
ADD COLUMN     "deprecatedMessage" TEXT;
