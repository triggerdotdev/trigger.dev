/*
  Warnings:

  - The values [CREATE_EXECUTION] on the enum `JobEventAction` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "JobEventAction_new" AS ENUM ('CREATE_RUN', 'RESUME_TASK');
ALTER TABLE "JobEventRule" ALTER COLUMN "action" DROP DEFAULT;
ALTER TABLE "JobEventRule" ALTER COLUMN "action" TYPE "JobEventAction_new" USING ("action"::text::"JobEventAction_new");
ALTER TYPE "JobEventAction" RENAME TO "JobEventAction_old";
ALTER TYPE "JobEventAction_new" RENAME TO "JobEventAction";
DROP TYPE "JobEventAction_old";
ALTER TABLE "JobEventRule" ALTER COLUMN "action" SET DEFAULT 'CREATE_RUN';
COMMIT;

-- AlterTable
ALTER TABLE "JobEventRule" ALTER COLUMN "action" SET DEFAULT 'CREATE_RUN';
