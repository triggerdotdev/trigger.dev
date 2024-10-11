/*
  Warnings:

  - The `provider` column on the `SecretReference` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- CreateEnum
CREATE TYPE "SecretStoreProvider" AS ENUM ('DATABASE', 'AWS_PARAM_STORE');

-- AlterTable
ALTER TABLE "SecretReference" DROP COLUMN "provider",
ADD COLUMN     "provider" "SecretStoreProvider" NOT NULL DEFAULT 'DATABASE';
