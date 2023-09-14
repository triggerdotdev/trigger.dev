/*
  Warnings:

  - Changed the type of `provider` on the `BackgroundTaskImage` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.
  - Changed the type of `provider` on the `BackgroundTaskMachine` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "BackgroundTaskProviderStrategy" AS ENUM ('FLY_IO');

-- AlterTable
ALTER TABLE "BackgroundTaskImage" DROP COLUMN "provider",
ADD COLUMN     "provider" "BackgroundTaskProviderStrategy" NOT NULL;

-- AlterTable
ALTER TABLE "BackgroundTaskMachine" DROP COLUMN "provider",
ADD COLUMN     "provider" "BackgroundTaskProviderStrategy" NOT NULL;

-- DropEnum
DROP TYPE "BackgroundTaskProvider";
