/*
  Warnings:

  - Added the required column `secretReferenceId` to the `TriggerSource` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TriggerSource" ADD COLUMN     "secretReferenceId" TEXT NOT NULL,
ALTER COLUMN "channelData" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "TriggerSource" ADD CONSTRAINT "TriggerSource_secretReferenceId_fkey" FOREIGN KEY ("secretReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;
