/*
  Warnings:

  - You are about to drop the column `executionId` on the `Task` table. All the data in the column will be lost.
  - You are about to drop the `Execution` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[projectId,slug,orgMemberId]` on the table `RuntimeEnvironment` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[runId,idempotencyKey]` on the table `Task` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `projectId` to the `Endpoint` table without a default value. This is not possible if the table is not empty.
  - Added the required column `projectId` to the `EventLog` table without a default value. This is not possible if the table is not empty.
  - Added the required column `projectId` to the `HttpSource` table without a default value. This is not possible if the table is not empty.
  - Added the required column `projectId` to the `Job` table without a default value. This is not possible if the table is not empty.
  - Added the required column `projectId` to the `JobEventRule` table without a default value. This is not possible if the table is not empty.
  - Added the required column `projectId` to the `JobInstance` table without a default value. This is not possible if the table is not empty.
  - Added the required column `projectId` to the `RuntimeEnvironment` table without a default value. This is not possible if the table is not empty.
  - Added the required column `runId` to the `Task` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OrgMemberRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "RuntimeEnvironmentType" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT', 'PREVIEW');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('PENDING', 'STARTED', 'SUCCESS', 'FAILURE', 'TIMED_OUT');

-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_endpointId_fkey";

-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_eventLogId_fkey";

-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_jobId_fkey";

-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_jobInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "Execution" DROP CONSTRAINT "Execution_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Task" DROP CONSTRAINT "Task_executionId_fkey";

-- DropIndex
DROP INDEX "RuntimeEnvironment_organizationId_slug_key";

-- DropIndex
DROP INDEX "Task_executionId_idempotencyKey_key";

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "EventLog" ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "HttpSource" ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "JobEventRule" ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "JobInstance" ADD COLUMN     "projectId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "RuntimeEnvironment" ADD COLUMN     "orgMemberId" TEXT,
ADD COLUMN     "projectId" TEXT NOT NULL,
ADD COLUMN     "type" "RuntimeEnvironmentType" NOT NULL DEFAULT 'DEVELOPMENT';

-- AlterTable
ALTER TABLE "Task" DROP COLUMN "executionId",
ADD COLUMN     "runId" TEXT NOT NULL;

-- DropTable
DROP TABLE "Execution";

-- DropEnum
DROP TYPE "ExecutionStatus";

-- CreateTable
CREATE TABLE "OrgMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgMemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobRun" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "jobId" TEXT NOT NULL,
    "jobInstanceId" TEXT NOT NULL,
    "eventLogId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "elements" JSONB,
    "status" "JobRunStatus" NOT NULL DEFAULT 'PENDING',
    "output" JSONB,
    "timedOutAt" TIMESTAMP(3),
    "timedOutReason" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "JobRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEnvironment_projectId_slug_orgMemberId_key" ON "RuntimeEnvironment"("projectId", "slug", "orgMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "Task_runId_idempotencyKey_key" ON "Task"("runId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgMember" ADD CONSTRAINT "OrgMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_orgMemberId_fkey" FOREIGN KEY ("orgMemberId") REFERENCES "OrgMember"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Endpoint" ADD CONSTRAINT "Endpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Job" ADD CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobInstance" ADD CONSTRAINT "JobInstance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_jobInstanceId_fkey" FOREIGN KEY ("jobInstanceId") REFERENCES "JobInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_eventLogId_fkey" FOREIGN KEY ("eventLogId") REFERENCES "EventLog"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_runId_fkey" FOREIGN KEY ("runId") REFERENCES "JobRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HttpSource" ADD CONSTRAINT "HttpSource_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobEventRule" ADD CONSTRAINT "JobEventRule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
