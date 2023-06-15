/*
  Warnings:

  - You are about to drop the column `apiIdentifier` on the `ApiConnection` table. All the data in the column will be lost.
  - You are about to drop the column `authenticationMethodKey` on the `ApiConnection` table. All the data in the column will be lost.
  - You are about to drop the column `scopes` on the `ApiConnection` table. All the data in the column will be lost.
  - You are about to drop the column `slug` on the `ApiConnection` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `ApiConnection` table. All the data in the column will be lost.
  - You are about to drop the column `apiConnectionId` on the `ApiConnectionAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `apiIdentifier` on the `ApiConnectionAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `authenticationMethodKey` on the `ApiConnectionAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `organizationId` on the `ApiConnectionAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `scopes` on the `ApiConnectionAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `ApiConnectionAttempt` table. All the data in the column will be lost.
  - You are about to drop the column `jobInstanceId` on the `JobAlias` table. All the data in the column will be lost.
  - You are about to drop the column `version` on the `JobAlias` table. All the data in the column will be lost.
  - You are about to drop the column `apiConnectionId` on the `JobConnection` table. All the data in the column will be lost.
  - You are about to drop the column `jobInstanceId` on the `JobConnection` table. All the data in the column will be lost.
  - You are about to drop the column `usesLocalAuth` on the `JobConnection` table. All the data in the column will be lost.
  - You are about to drop the column `eventLogId` on the `JobRun` table. All the data in the column will be lost.
  - You are about to drop the column `jobInstanceId` on the `JobRun` table. All the data in the column will be lost.
  - You are about to drop the `CurrentEnvironment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeploymentLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeploymentLogPoll` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DurableDelay` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EventLog` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EventRule` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ExternalService` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ExternalSource` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `FetchRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `FetchResponse` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `GitHubAppAuthorization` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `GitHubAppAuthorizationAttempt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `IntegrationRequest` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `IntegrationResponse` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InternalSource` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobEventRule` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobInstance` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `KeyValueItem` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `OrganizationTemplate` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ProjectDeployment` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `RepositoryProject` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SchedulerSource` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Template` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TriggerEvent` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Workflow` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WorkflowRun` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WorkflowRunStep` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[versionId,key]` on the table `JobConnection` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `clientId` to the `ApiConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `clientId` to the `ApiConnectionAttempt` table without a default value. This is not possible if the table is not empty.
  - Added the required column `value` to the `JobAlias` table without a default value. This is not possible if the table is not empty.
  - Added the required column `versionId` to the `JobAlias` table without a default value. This is not possible if the table is not empty.
  - Added the required column `apiConnectionClientId` to the `JobConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `versionId` to the `JobConnection` table without a default value. This is not possible if the table is not empty.
  - Added the required column `eventId` to the `JobRun` table without a default value. This is not possible if the table is not empty.
  - Added the required column `versionId` to the `JobRun` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "ApiConnectionType" AS ENUM ('EXTERNAL', 'DEVELOPER');

-- CreateEnum
CREATE TYPE "JobTriggerAction" AS ENUM ('CREATE_RUN', 'RESUME_TASK');

-- DropForeignKey
ALTER TABLE "ApiConnectionAttempt" DROP CONSTRAINT "ApiConnectionAttempt_apiConnectionId_fkey";

-- DropForeignKey
ALTER TABLE "CurrentEnvironment" DROP CONSTRAINT "CurrentEnvironment_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "CurrentEnvironment" DROP CONSTRAINT "CurrentEnvironment_userId_fkey";

-- DropForeignKey
ALTER TABLE "CurrentEnvironment" DROP CONSTRAINT "CurrentEnvironment_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "DeploymentLog" DROP CONSTRAINT "DeploymentLog_deploymentId_fkey";

-- DropForeignKey
ALTER TABLE "DeploymentLogPoll" DROP CONSTRAINT "DeploymentLogPoll_deploymentId_fkey";

-- DropForeignKey
ALTER TABLE "DurableDelay" DROP CONSTRAINT "DurableDelay_runId_fkey";

-- DropForeignKey
ALTER TABLE "DurableDelay" DROP CONSTRAINT "DurableDelay_stepId_fkey";

-- DropForeignKey
ALTER TABLE "EventLog" DROP CONSTRAINT "EventLog_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "EventLog" DROP CONSTRAINT "EventLog_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "EventLog" DROP CONSTRAINT "EventLog_projectId_fkey";

-- DropForeignKey
ALTER TABLE "EventRule" DROP CONSTRAINT "EventRule_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "EventRule" DROP CONSTRAINT "EventRule_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "EventRule" DROP CONSTRAINT "EventRule_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "ExternalService" DROP CONSTRAINT "ExternalService_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "ExternalService" DROP CONSTRAINT "ExternalService_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "ExternalSource" DROP CONSTRAINT "ExternalSource_connectionId_fkey";

-- DropForeignKey
ALTER TABLE "ExternalSource" DROP CONSTRAINT "ExternalSource_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "FetchRequest" DROP CONSTRAINT "FetchRequest_runId_fkey";

-- DropForeignKey
ALTER TABLE "FetchRequest" DROP CONSTRAINT "FetchRequest_stepId_fkey";

-- DropForeignKey
ALTER TABLE "FetchResponse" DROP CONSTRAINT "FetchResponse_requestId_fkey";

-- DropForeignKey
ALTER TABLE "GitHubAppAuthorization" DROP CONSTRAINT "GitHubAppAuthorization_userId_fkey";

-- DropForeignKey
ALTER TABLE "GitHubAppAuthorizationAttempt" DROP CONSTRAINT "GitHubAppAuthorizationAttempt_authorizationId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationRequest" DROP CONSTRAINT "IntegrationRequest_externalServiceId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationRequest" DROP CONSTRAINT "IntegrationRequest_runId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationRequest" DROP CONSTRAINT "IntegrationRequest_stepId_fkey";

-- DropForeignKey
ALTER TABLE "IntegrationResponse" DROP CONSTRAINT "IntegrationResponse_requestId_fkey";

-- DropForeignKey
ALTER TABLE "InternalSource" DROP CONSTRAINT "InternalSource_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "InternalSource" DROP CONSTRAINT "InternalSource_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "InternalSource" DROP CONSTRAINT "InternalSource_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "JobAlias" DROP CONSTRAINT "JobAlias_jobInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "JobConnection" DROP CONSTRAINT "JobConnection_apiConnectionId_fkey";

-- DropForeignKey
ALTER TABLE "JobConnection" DROP CONSTRAINT "JobConnection_jobInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "JobEventRule" DROP CONSTRAINT "JobEventRule_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "JobEventRule" DROP CONSTRAINT "JobEventRule_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobEventRule" DROP CONSTRAINT "JobEventRule_jobInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "JobEventRule" DROP CONSTRAINT "JobEventRule_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "JobEventRule" DROP CONSTRAINT "JobEventRule_projectId_fkey";

-- DropForeignKey
ALTER TABLE "JobInstance" DROP CONSTRAINT "JobInstance_endpointId_fkey";

-- DropForeignKey
ALTER TABLE "JobInstance" DROP CONSTRAINT "JobInstance_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "JobInstance" DROP CONSTRAINT "JobInstance_jobId_fkey";

-- DropForeignKey
ALTER TABLE "JobInstance" DROP CONSTRAINT "JobInstance_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "JobInstance" DROP CONSTRAINT "JobInstance_projectId_fkey";

-- DropForeignKey
ALTER TABLE "JobInstance" DROP CONSTRAINT "JobInstance_queueId_fkey";

-- DropForeignKey
ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_eventLogId_fkey";

-- DropForeignKey
ALTER TABLE "JobRun" DROP CONSTRAINT "JobRun_jobInstanceId_fkey";

-- DropForeignKey
ALTER TABLE "KeyValueItem" DROP CONSTRAINT "KeyValueItem_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationTemplate" DROP CONSTRAINT "OrganizationTemplate_authorizationId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationTemplate" DROP CONSTRAINT "OrganizationTemplate_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "OrganizationTemplate" DROP CONSTRAINT "OrganizationTemplate_templateId_fkey";

-- DropForeignKey
ALTER TABLE "ProjectDeployment" DROP CONSTRAINT "ProjectDeployment_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "ProjectDeployment" DROP CONSTRAINT "ProjectDeployment_projectId_fkey";

-- DropForeignKey
ALTER TABLE "RepositoryProject" DROP CONSTRAINT "RepositoryProject_authorizationId_fkey";

-- DropForeignKey
ALTER TABLE "RepositoryProject" DROP CONSTRAINT "RepositoryProject_currentDeploymentId_fkey";

-- DropForeignKey
ALTER TABLE "RepositoryProject" DROP CONSTRAINT "RepositoryProject_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "SchedulerSource" DROP CONSTRAINT "SchedulerSource_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "SchedulerSource" DROP CONSTRAINT "SchedulerSource_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "SchedulerSource" DROP CONSTRAINT "SchedulerSource_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "TriggerEvent" DROP CONSTRAINT "TriggerEvent_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "TriggerEvent" DROP CONSTRAINT "TriggerEvent_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Workflow" DROP CONSTRAINT "Workflow_externalSourceId_fkey";

-- DropForeignKey
ALTER TABLE "Workflow" DROP CONSTRAINT "Workflow_organizationId_fkey";

-- DropForeignKey
ALTER TABLE "Workflow" DROP CONSTRAINT "Workflow_organizationTemplateId_fkey";

-- DropForeignKey
ALTER TABLE "Workflow" DROP CONSTRAINT "Workflow_repositoryProjectId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_environmentId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_eventId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_eventRuleId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRun" DROP CONSTRAINT "WorkflowRun_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "WorkflowRunStep" DROP CONSTRAINT "WorkflowRunStep_runId_fkey";

-- DropIndex
DROP INDEX "ApiConnection_organizationId_slug_key";

-- DropIndex
DROP INDEX "JobConnection_jobInstanceId_key_key";

-- AlterTable
ALTER TABLE "ApiConnection" DROP COLUMN "apiIdentifier",
DROP COLUMN "authenticationMethodKey",
DROP COLUMN "scopes",
DROP COLUMN "slug",
DROP COLUMN "title",
ADD COLUMN     "clientId" TEXT NOT NULL,
ADD COLUMN     "connectionType" "ApiConnectionType" NOT NULL DEFAULT 'DEVELOPER',
ADD COLUMN     "externalAccountId" TEXT;

-- AlterTable
ALTER TABLE "ApiConnectionAttempt" DROP COLUMN "apiConnectionId",
DROP COLUMN "apiIdentifier",
DROP COLUMN "authenticationMethodKey",
DROP COLUMN "organizationId",
DROP COLUMN "scopes",
DROP COLUMN "title",
ADD COLUMN     "clientId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "JobAlias" DROP COLUMN "jobInstanceId",
DROP COLUMN "version",
ADD COLUMN     "value" TEXT NOT NULL,
ADD COLUMN     "versionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "JobConnection" DROP COLUMN "apiConnectionId",
DROP COLUMN "jobInstanceId",
DROP COLUMN "usesLocalAuth",
ADD COLUMN     "apiConnectionClientId" TEXT NOT NULL,
ADD COLUMN     "versionId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "JobRun" DROP COLUMN "eventLogId",
DROP COLUMN "jobInstanceId",
ADD COLUMN     "eventId" TEXT NOT NULL,
ADD COLUMN     "versionId" TEXT NOT NULL;

-- DropTable
DROP TABLE "CurrentEnvironment";

-- DropTable
DROP TABLE "DeploymentLog";

-- DropTable
DROP TABLE "DeploymentLogPoll";

-- DropTable
DROP TABLE "DurableDelay";

-- DropTable
DROP TABLE "EventLog";

-- DropTable
DROP TABLE "EventRule";

-- DropTable
DROP TABLE "ExternalService";

-- DropTable
DROP TABLE "ExternalSource";

-- DropTable
DROP TABLE "FetchRequest";

-- DropTable
DROP TABLE "FetchResponse";

-- DropTable
DROP TABLE "GitHubAppAuthorization";

-- DropTable
DROP TABLE "GitHubAppAuthorizationAttempt";

-- DropTable
DROP TABLE "IntegrationRequest";

-- DropTable
DROP TABLE "IntegrationResponse";

-- DropTable
DROP TABLE "InternalSource";

-- DropTable
DROP TABLE "JobEventRule";

-- DropTable
DROP TABLE "JobInstance";

-- DropTable
DROP TABLE "KeyValueItem";

-- DropTable
DROP TABLE "OrganizationTemplate";

-- DropTable
DROP TABLE "ProjectDeployment";

-- DropTable
DROP TABLE "RepositoryProject";

-- DropTable
DROP TABLE "SchedulerSource";

-- DropTable
DROP TABLE "Template";

-- DropTable
DROP TABLE "TriggerEvent";

-- DropTable
DROP TABLE "Workflow";

-- DropTable
DROP TABLE "WorkflowRun";

-- DropTable
DROP TABLE "WorkflowRunStep";

-- DropEnum
DROP TYPE "DeploymentLogType";

-- DropEnum
DROP TYPE "ExternalServiceStatus";

-- DropEnum
DROP TYPE "ExternalServiceType";

-- DropEnum
DROP TYPE "ExternalSourceStatus";

-- DropEnum
DROP TYPE "ExternalSourceType";

-- DropEnum
DROP TYPE "FetchRequestStatus";

-- DropEnum
DROP TYPE "GitHubAccountType";

-- DropEnum
DROP TYPE "IntegrationRequestStatus";

-- DropEnum
DROP TYPE "InternalSourceStatus";

-- DropEnum
DROP TYPE "InternalSourceType";

-- DropEnum
DROP TYPE "JobEventAction";

-- DropEnum
DROP TYPE "OrganizationTemplateStatus";

-- DropEnum
DROP TYPE "ProjectDeploymentStatus";

-- DropEnum
DROP TYPE "RepositoryProjectStatus";

-- DropEnum
DROP TYPE "SchedulerSourceStatus";

-- DropEnum
DROP TYPE "TriggerEventStatus";

-- DropEnum
DROP TYPE "TriggerType";

-- DropEnum
DROP TYPE "WorkflowRunStatus";

-- DropEnum
DROP TYPE "WorkflowRunStepStatus";

-- DropEnum
DROP TYPE "WorkflowRunStepType";

-- DropEnum
DROP TYPE "WorkflowStatus";

-- CreateTable
CREATE TABLE "ExternalAccount" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "metadata" JSONB,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiConnectionClient" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "schema" JSONB NOT NULL,
    "scopes" TEXT[],
    "credentialsReferenceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "organizationId" TEXT NOT NULL,

    CONSTRAINT "ApiConnectionClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobVersion" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "eventSpecification" JSONB NOT NULL,
    "jobId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "ready" BOOLEAN NOT NULL DEFAULT false,
    "latest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JobVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JobTrigger" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "payloadFilter" JSONB,
    "contextFilter" JSONB,
    "action" "JobTriggerAction" NOT NULL DEFAULT 'CREATE_RUN',
    "actionIdentifier" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "jobId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "externalAccountId" TEXT,

    CONSTRAINT "JobTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventRecord" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,
    "context" JSONB,
    "source" TEXT NOT NULL DEFAULT 'trigger.dev',
    "organizationId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "deliverAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deliveredAt" TIMESTAMP(3),
    "isTest" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EventRecord_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExternalAccount_organizationId_identifier_key" ON "ExternalAccount"("organizationId", "identifier");

-- CreateIndex
CREATE UNIQUE INDEX "ApiConnectionClient_organizationId_slug_key" ON "ApiConnectionClient"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "JobVersion_jobId_version_endpointId_key" ON "JobVersion"("jobId", "version", "endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "JobTrigger_versionId_actionIdentifier_key" ON "JobTrigger"("versionId", "actionIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "JobConnection_versionId_key_key" ON "JobConnection"("versionId", "key");

-- AddForeignKey
ALTER TABLE "ExternalAccount" ADD CONSTRAINT "ExternalAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiConnectionClient" ADD CONSTRAINT "ApiConnectionClient_credentialsReferenceId_fkey" FOREIGN KEY ("credentialsReferenceId") REFERENCES "SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiConnectionClient" ADD CONSTRAINT "ApiConnectionClient_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiConnection" ADD CONSTRAINT "ApiConnection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiConnectionClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiConnection" ADD CONSTRAINT "ApiConnection_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApiConnectionAttempt" ADD CONSTRAINT "ApiConnectionAttempt_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "ApiConnectionClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobVersion" ADD CONSTRAINT "JobVersion_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "JobQueue"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobAlias" ADD CONSTRAINT "JobAlias_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobConnection" ADD CONSTRAINT "JobConnection_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobConnection" ADD CONSTRAINT "JobConnection_apiConnectionClientId_fkey" FOREIGN KEY ("apiConnectionClientId") REFERENCES "ApiConnectionClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrigger" ADD CONSTRAINT "JobTrigger_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrigger" ADD CONSTRAINT "JobTrigger_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrigger" ADD CONSTRAINT "JobTrigger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrigger" ADD CONSTRAINT "JobTrigger_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrigger" ADD CONSTRAINT "JobTrigger_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobTrigger" ADD CONSTRAINT "JobTrigger_externalAccountId_fkey" FOREIGN KEY ("externalAccountId") REFERENCES "ExternalAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRecord" ADD CONSTRAINT "EventRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRecord" ADD CONSTRAINT "EventRecord_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventRecord" ADD CONSTRAINT "EventRecord_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "JobVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JobRun" ADD CONSTRAINT "JobRun_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "EventRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
