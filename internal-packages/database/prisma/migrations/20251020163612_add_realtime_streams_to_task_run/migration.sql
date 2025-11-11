-- AlterTable
ALTER TABLE "public"."TaskRun" ADD COLUMN     "realtimeStreams" TEXT[] DEFAULT ARRAY[]::TEXT[];