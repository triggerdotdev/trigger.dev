-- AlterTable
ALTER TABLE "public"."PlaygroundConversation" ADD COLUMN "lastEventId" TEXT,
ADD COLUMN "messages" JSONB;
