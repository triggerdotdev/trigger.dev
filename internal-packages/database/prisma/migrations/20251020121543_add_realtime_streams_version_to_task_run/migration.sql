-- AlterTable
ALTER TABLE "public"."TaskRun" ADD COLUMN     "realtimeStreamsVersion" TEXT NOT NULL DEFAULT 'v1';