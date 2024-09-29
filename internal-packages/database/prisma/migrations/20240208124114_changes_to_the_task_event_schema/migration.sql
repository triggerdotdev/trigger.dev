/*
  Warnings:

  - You are about to drop the column `attemptNumber` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `environmentSlug` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `eventData` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `organizationName` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `organizationSlug` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `projectName` on the `TaskEvent` table. All the data in the column will be lost.
  - You are about to drop the column `taskId` on the `TaskEvent` table. All the data in the column will be lost.
  - Added the required column `properties` to the `TaskEvent` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "TaskEvent" DROP COLUMN "attemptNumber",
DROP COLUMN "environmentSlug",
DROP COLUMN "eventData",
DROP COLUMN "organizationName",
DROP COLUMN "organizationSlug",
DROP COLUMN "projectName",
DROP COLUMN "taskId",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "isError" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPartial" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "output" JSONB,
ADD COLUMN     "properties" JSONB NOT NULL,
ADD COLUMN     "style" JSONB,
ALTER COLUMN "attemptId" DROP NOT NULL;
