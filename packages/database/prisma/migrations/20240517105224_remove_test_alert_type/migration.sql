/*
  Warnings:

  - The values [TEST] on the enum `ProjectAlertType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "ProjectAlertType_new" AS ENUM ('TASK_RUN_ATTEMPT', 'DEPLOYMENT_FAILURE', 'DEPLOYMENT_SUCCESS');
ALTER TABLE "ProjectAlertChannel" ALTER COLUMN "alertTypes" TYPE "ProjectAlertType_new"[] USING ("alertTypes"::text::"ProjectAlertType_new"[]);
ALTER TABLE "ProjectAlert" ALTER COLUMN "type" TYPE "ProjectAlertType_new" USING ("type"::text::"ProjectAlertType_new");
ALTER TABLE "ProjectAlertStorage" ALTER COLUMN "alertType" TYPE "ProjectAlertType_new" USING ("alertType"::text::"ProjectAlertType_new");
ALTER TYPE "ProjectAlertType" RENAME TO "ProjectAlertType_old";
ALTER TYPE "ProjectAlertType_new" RENAME TO "ProjectAlertType";
DROP TYPE "ProjectAlertType_old";
COMMIT;
