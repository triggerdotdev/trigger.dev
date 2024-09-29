/*
  Warnings:

  - The values [INITIAL,RETRY,RESUME] on the enum `JobRunExecutionReason` will be removed. If these variants are still used in the database, this will fail.
  - You are about to drop the column `number` on the `JobRunExecution` table. All the data in the column will be lost.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "JobRunExecutionReason_new" AS ENUM ('PREPROCESS', 'EXECUTE_JOB');
ALTER TABLE "JobRunExecution" ALTER COLUMN "reason" DROP DEFAULT;
ALTER TABLE "JobRunExecution" ALTER COLUMN "reason" TYPE "JobRunExecutionReason_new" USING ("reason"::text::"JobRunExecutionReason_new");
ALTER TYPE "JobRunExecutionReason" RENAME TO "JobRunExecutionReason_old";
ALTER TYPE "JobRunExecutionReason_new" RENAME TO "JobRunExecutionReason";
DROP TYPE "JobRunExecutionReason_old";
ALTER TABLE "JobRunExecution" ALTER COLUMN "reason" SET DEFAULT 'EXECUTE_JOB';
COMMIT;

-- DropIndex
DROP INDEX "JobRunExecution_runId_number_key";

-- AlterTable
ALTER TABLE "JobRunExecution" DROP COLUMN "number",
ADD COLUMN     "error" TEXT,
ADD COLUMN     "retryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryDelayInMs" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retryLimit" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "reason" SET DEFAULT 'EXECUTE_JOB';
