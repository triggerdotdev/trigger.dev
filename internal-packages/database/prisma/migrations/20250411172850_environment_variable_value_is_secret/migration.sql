-- AlterTable
ALTER TABLE "EnvironmentVariableValue"
ADD COLUMN "isSecret" BOOLEAN NOT NULL DEFAULT false;