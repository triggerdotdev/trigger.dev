-- CreateEnum
CREATE TYPE "APIAuthenticationMethod" AS ENUM ('OAUTH', 'API_KEY');

-- AlterTable
ALTER TABLE "APIConnection" ADD COLUMN     "authenticationMethod" "APIAuthenticationMethod" NOT NULL DEFAULT 'OAUTH';
