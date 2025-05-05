-- CreateEnum
CREATE TYPE "WaitpointResolver" AS ENUM ('ENGINE', 'TOKEN', 'HTTP_CALLBACK');

-- AlterTable
ALTER TABLE "Waitpoint"
ADD COLUMN "resolver" "WaitpointResolver" NOT NULL DEFAULT 'ENGINE';