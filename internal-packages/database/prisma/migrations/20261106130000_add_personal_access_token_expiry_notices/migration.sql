-- AlterTable
ALTER TABLE "PersonalAccessToken" ADD COLUMN IF NOT EXISTS "expiryReminderSentAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "expiredNoticeSentAt" TIMESTAMP(3);
