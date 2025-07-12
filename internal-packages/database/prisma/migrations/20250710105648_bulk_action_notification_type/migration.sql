-- CreateEnum
CREATE TYPE "BulkActionNotificationType" AS ENUM ('NONE', 'EMAIL');

-- AlterTable
ALTER TABLE "BulkActionGroup"
ADD COLUMN "completionNotification" "BulkActionNotificationType" NOT NULL DEFAULT 'NONE';