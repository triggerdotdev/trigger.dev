/*
  Warnings:

  - The values [PROCESSED] on the enum `TriggerEventStatus` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `processedAt` on the `TriggerEvent` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "TriggerEventStatus_new" AS ENUM ('PENDING', 'DISPATCHED');
ALTER TABLE "TriggerEvent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "TriggerEvent" ALTER COLUMN "status" TYPE "TriggerEventStatus_new" USING ("status"::text::"TriggerEventStatus_new");
ALTER TYPE "TriggerEventStatus" RENAME TO "TriggerEventStatus_old";
ALTER TYPE "TriggerEventStatus_new" RENAME TO "TriggerEventStatus";
DROP TYPE "TriggerEventStatus_old";
ALTER TABLE "TriggerEvent" ALTER COLUMN "status" SET DEFAULT 'PENDING';
COMMIT;

-- AlterTable
ALTER TABLE "TriggerEvent" DROP COLUMN "processedAt",
ADD COLUMN     "dispatchedAt" TIMESTAMP(3);
