/*
  Warnings:

  - You are about to drop the column `authenticationConfig` on the `APIConnection` table. All the data in the column will be lost.
  - You are about to drop the column `authenticationMethod` on the `APIConnection` table. All the data in the column will be lost.
  - You are about to drop the column `scopes` on the `APIConnection` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `APIConnection` table. All the data in the column will be lost.
  - You are about to drop the column `type` on the `APIConnection` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[dataReferenceId]` on the table `APIConnection` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `authenticationMethodKey` to the `APIConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `dataReferenceId` to the `APIConnection` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "APIConnection" DROP COLUMN "authenticationConfig",
DROP COLUMN "authenticationMethod",
DROP COLUMN "scopes",
DROP COLUMN "status",
DROP COLUMN "type",
ADD COLUMN     "authenticationMethodKey" TEXT NOT NULL,
ADD COLUMN     "dataReferenceId" TEXT NOT NULL;

-- DropEnum
DROP TYPE "APIAuthenticationMethod";

-- DropEnum
DROP TYPE "APIConnectionStatus";

-- DropEnum
DROP TYPE "APIConnectionType";

-- CreateTable
CREATE TABLE "SecretReference" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretStore" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SecretStore_key_key" ON "SecretStore"("key");

-- CreateIndex
CREATE UNIQUE INDEX "APIConnection_dataReferenceId_key" ON "APIConnection"("dataReferenceId");

-- AddForeignKey
ALTER TABLE "APIConnection" ADD CONSTRAINT "APIConnection_dataReferenceId_fkey" FOREIGN KEY ("dataReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;
