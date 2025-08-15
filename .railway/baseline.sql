-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "public"."AuthenticationMethod" AS ENUM ('GITHUB', 'MAGIC_LINK');

-- CreateEnum
CREATE TYPE "public"."OrgMemberRole" AS ENUM ('ADMIN', 'MEMBER');

-- CreateEnum
CREATE TYPE "public"."RuntimeEnvironmentType" AS ENUM ('PRODUCTION', 'STAGING', 'DEVELOPMENT', 'PREVIEW');

-- CreateEnum
CREATE TYPE "public"."ProjectVersion" AS ENUM ('V2', 'V3');

-- CreateEnum
CREATE TYPE "public"."SecretStoreProvider" AS ENUM ('DATABASE', 'AWS_PARAM_STORE');

-- CreateEnum
CREATE TYPE "public"."TaskTriggerSource" AS ENUM ('STANDARD', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "public"."TaskRunStatus" AS ENUM ('DELAYED', 'PENDING', 'PENDING_VERSION', 'WAITING_FOR_DEPLOY', 'DEQUEUED', 'EXECUTING', 'WAITING_TO_RESUME', 'RETRYING_AFTER_FAILURE', 'PAUSED', 'CANCELED', 'INTERRUPTED', 'COMPLETED_SUCCESSFULLY', 'COMPLETED_WITH_ERRORS', 'SYSTEM_FAILURE', 'CRASHED', 'EXPIRED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "public"."RunEngineVersion" AS ENUM ('V1', 'V2');

-- CreateEnum
CREATE TYPE "public"."TaskRunExecutionStatus" AS ENUM ('RUN_CREATED', 'QUEUED', 'QUEUED_EXECUTING', 'PENDING_EXECUTING', 'EXECUTING', 'EXECUTING_WITH_WAITPOINTS', 'SUSPENDED', 'PENDING_CANCEL', 'FINISHED');

-- CreateEnum
CREATE TYPE "public"."TaskRunCheckpointType" AS ENUM ('DOCKER', 'KUBERNETES');

-- CreateEnum
CREATE TYPE "public"."WaitpointType" AS ENUM ('RUN', 'DATETIME', 'MANUAL', 'BATCH');

-- CreateEnum
CREATE TYPE "public"."WaitpointStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."WorkerInstanceGroupType" AS ENUM ('MANAGED', 'UNMANAGED');

-- CreateEnum
CREATE TYPE "public"."TaskRunAttemptStatus" AS ENUM ('PENDING', 'EXECUTING', 'PAUSED', 'FAILED', 'CANCELED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."TaskEventLevel" AS ENUM ('TRACE', 'DEBUG', 'LOG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "public"."TaskEventKind" AS ENUM ('UNSPECIFIED', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER', 'UNRECOGNIZED', 'LOG');

-- CreateEnum
CREATE TYPE "public"."TaskEventStatus" AS ENUM ('UNSET', 'OK', 'ERROR', 'UNRECOGNIZED');

-- CreateEnum
CREATE TYPE "public"."TaskQueueType" AS ENUM ('VIRTUAL', 'NAMED');

-- CreateEnum
CREATE TYPE "public"."TaskQueueVersion" AS ENUM ('V1', 'V2');

-- CreateEnum
CREATE TYPE "public"."BatchTaskRunStatus" AS ENUM ('PENDING', 'COMPLETED', 'ABORTED');

-- CreateEnum
CREATE TYPE "public"."BatchTaskRunItemStatus" AS ENUM ('PENDING', 'FAILED', 'CANCELED', 'COMPLETED');

-- CreateEnum
CREATE TYPE "public"."CheckpointType" AS ENUM ('DOCKER', 'KUBERNETES');

-- CreateEnum
CREATE TYPE "public"."CheckpointRestoreEventType" AS ENUM ('CHECKPOINT', 'RESTORE');

-- CreateEnum
CREATE TYPE "public"."WorkerDeploymentType" AS ENUM ('MANAGED', 'UNMANAGED', 'V1');

-- CreateEnum
CREATE TYPE "public"."WorkerDeploymentStatus" AS ENUM ('PENDING', 'BUILDING', 'DEPLOYING', 'DEPLOYED', 'FAILED', 'CANCELED', 'TIMED_OUT');

-- CreateEnum
CREATE TYPE "public"."ScheduleType" AS ENUM ('DECLARATIVE', 'IMPERATIVE');

-- CreateEnum
CREATE TYPE "public"."ScheduleGeneratorType" AS ENUM ('CRON');

-- CreateEnum
CREATE TYPE "public"."ProjectAlertChannelType" AS ENUM ('EMAIL', 'SLACK', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "public"."ProjectAlertType" AS ENUM ('TASK_RUN', 'TASK_RUN_ATTEMPT', 'DEPLOYMENT_FAILURE', 'DEPLOYMENT_SUCCESS');

-- CreateEnum
CREATE TYPE "public"."ProjectAlertStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "public"."IntegrationService" AS ENUM ('SLACK');

-- CreateEnum
CREATE TYPE "public"."BulkActionType" AS ENUM ('CANCEL', 'REPLAY');

-- CreateEnum
CREATE TYPE "public"."BulkActionStatus" AS ENUM ('PENDING', 'COMPLETED', 'ABORTED');

-- CreateEnum
CREATE TYPE "public"."BulkActionNotificationType" AS ENUM ('NONE', 'EMAIL');

-- CreateEnum
CREATE TYPE "public"."BulkActionItemStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "public"."User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "authenticationMethod" "public"."AuthenticationMethod" NOT NULL,
    "authenticationProfile" JSONB,
    "authenticationExtraParams" JSONB,
    "authIdentifier" TEXT,
    "displayName" TEXT,
    "name" TEXT,
    "avatarUrl" TEXT,
    "admin" BOOLEAN NOT NULL DEFAULT false,
    "dashboardPreferences" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "isOnCloudWaitlist" BOOLEAN NOT NULL DEFAULT false,
    "featureCloud" BOOLEAN NOT NULL DEFAULT false,
    "isOnHostedRepoWaitlist" BOOLEAN NOT NULL DEFAULT false,
    "marketingEmails" BOOLEAN NOT NULL DEFAULT true,
    "confirmedBasicDetails" BOOLEAN NOT NULL DEFAULT false,
    "referralSource" TEXT,
    "mfaEnabledAt" TIMESTAMP(3),
    "mfaSecretReferenceId" TEXT,
    "mfaLastUsedCode" TEXT,
    "invitationCodeId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."MfaBackupCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MfaBackupCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."InvitationCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvitationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."AuthorizationCode" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "personalAccessTokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthorizationCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."PersonalAccessToken" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "encryptedToken" JSONB NOT NULL,
    "obfuscatedToken" TEXT NOT NULL,
    "hashedToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastAccessedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Organization" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "maximumExecutionTimePerRunInMs" INTEGER NOT NULL DEFAULT 900000,
    "maximumConcurrencyLimit" INTEGER NOT NULL DEFAULT 10,
    "maximumSchedulesLimit" INTEGER NOT NULL DEFAULT 5,
    "maximumDevQueueSize" INTEGER,
    "maximumDeployedQueueSize" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "companySize" TEXT,
    "avatar" JSONB,
    "runsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "v3Enabled" BOOLEAN NOT NULL DEFAULT false,
    "v2Enabled" BOOLEAN NOT NULL DEFAULT false,
    "v2MarqsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "hasRequestedV3" BOOLEAN NOT NULL DEFAULT false,
    "apiRateLimiterConfig" JSONB,
    "realtimeRateLimiterConfig" JSONB,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrgMember" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "public"."OrgMemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrgMemberInvite" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "public"."OrgMemberRole" NOT NULL DEFAULT 'MEMBER',
    "organizationId" TEXT NOT NULL,
    "inviterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrgMemberInvite_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RuntimeEnvironment" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "apiKey" TEXT NOT NULL,
    "pkApiKey" TEXT NOT NULL,
    "type" "public"."RuntimeEnvironmentType" NOT NULL DEFAULT 'DEVELOPMENT',
    "isBranchableEnvironment" BOOLEAN NOT NULL DEFAULT false,
    "branchName" TEXT,
    "parentEnvironmentId" TEXT,
    "git" JSONB,
    "archivedAt" TIMESTAMP(3),
    "shortcode" TEXT NOT NULL,
    "maximumConcurrencyLimit" INTEGER NOT NULL DEFAULT 5,
    "concurrencyLimitBurstFactor" DECIMAL(4,2) NOT NULL DEFAULT 2.00,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "autoEnableInternalSources" BOOLEAN NOT NULL DEFAULT true,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "orgMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "builtInEnvironmentVariableOverrides" JSONB,
    "tunnelId" TEXT,
    "currentSessionId" TEXT,

    CONSTRAINT "RuntimeEnvironment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Project" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "externalRef" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "version" "public"."ProjectVersion" NOT NULL DEFAULT 'V2',
    "engine" "public"."RunEngineVersion" NOT NULL DEFAULT 'V1',
    "builderProjectId" TEXT,
    "defaultWorkerGroupId" TEXT,
    "allowedMasterQueues" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SecretReference" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "provider" "public"."SecretStoreProvider" NOT NULL DEFAULT 'DATABASE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."SecretStore" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" TEXT NOT NULL DEFAULT '1',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "public"."DataMigration" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataMigration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BackgroundWorker" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "engine" "public"."RunEngineVersion" NOT NULL DEFAULT 'V1',
    "contentHash" TEXT NOT NULL,
    "sdkVersion" TEXT NOT NULL DEFAULT 'unknown',
    "cliVersion" TEXT NOT NULL DEFAULT 'unknown',
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "metadata" JSONB NOT NULL,
    "runtime" TEXT,
    "runtimeVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "workerGroupId" TEXT,
    "supportsLazyAttempts" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "BackgroundWorker_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BackgroundWorkerFile" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "contents" BYTEA NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BackgroundWorkerFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BackgroundWorkerTask" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "friendlyId" TEXT NOT NULL,
    "filePath" TEXT NOT NULL,
    "exportName" TEXT,
    "workerId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "fileId" TEXT,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "queueConfig" JSONB,
    "retryConfig" JSONB,
    "machineConfig" JSONB,
    "queueId" TEXT,
    "maxDurationInSeconds" INTEGER,
    "triggerSource" "public"."TaskTriggerSource" NOT NULL DEFAULT 'STANDARD',
    "payloadSchema" JSONB,

    CONSTRAINT "BackgroundWorkerTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRun" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL DEFAULT 0,
    "friendlyId" TEXT NOT NULL,
    "engine" "public"."RunEngineVersion" NOT NULL DEFAULT 'V1',
    "status" "public"."TaskRunStatus" NOT NULL DEFAULT 'PENDING',
    "statusReason" TEXT,
    "idempotencyKey" TEXT,
    "idempotencyKeyExpiresAt" TIMESTAMP(3),
    "taskIdentifier" TEXT NOT NULL,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "payload" TEXT NOT NULL,
    "payloadType" TEXT NOT NULL DEFAULT 'application/json',
    "context" JSONB,
    "traceContext" JSONB,
    "traceId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType",
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT,
    "queue" TEXT NOT NULL,
    "lockedQueueId" TEXT,
    "masterQueue" TEXT NOT NULL DEFAULT 'main',
    "secondaryMasterQueue" TEXT,
    "attemptNumber" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "runTags" TEXT[],
    "taskVersion" TEXT,
    "sdkVersion" TEXT,
    "cliVersion" TEXT,
    "startedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "machinePreset" TEXT,
    "usageDurationMs" INTEGER NOT NULL DEFAULT 0,
    "costInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "baseCostInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lockedAt" TIMESTAMP(3),
    "lockedById" TEXT,
    "lockedToVersionId" TEXT,
    "priorityMs" INTEGER NOT NULL DEFAULT 0,
    "concurrencyKey" TEXT,
    "delayUntil" TIMESTAMP(3),
    "queuedAt" TIMESTAMP(3),
    "ttl" TEXT,
    "expiredAt" TIMESTAMP(3),
    "maxAttempts" INTEGER,
    "oneTimeUseToken" TEXT,
    "taskEventStore" TEXT NOT NULL DEFAULT 'taskEvent',
    "queueTimestamp" TIMESTAMP(3),
    "scheduleInstanceId" TEXT,
    "scheduleId" TEXT,
    "bulkActionGroupIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "logsDeletedAt" TIMESTAMP(3),
    "replayedFromTaskRunFriendlyId" TEXT,
    "rootTaskRunId" TEXT,
    "parentTaskRunId" TEXT,
    "parentTaskRunAttemptId" TEXT,
    "batchId" TEXT,
    "resumeParentOnCompletion" BOOLEAN NOT NULL DEFAULT false,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "parentSpanId" TEXT,
    "runChainState" JSONB,
    "seedMetadata" TEXT,
    "seedMetadataType" TEXT NOT NULL DEFAULT 'application/json',
    "metadata" TEXT,
    "metadataType" TEXT NOT NULL DEFAULT 'application/json',
    "metadataVersion" INTEGER NOT NULL DEFAULT 1,
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',
    "error" JSONB,
    "maxDurationInSeconds" INTEGER,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunTemplate" (
    "id" TEXT NOT NULL,
    "taskSlug" TEXT NOT NULL,
    "triggerSource" "public"."TaskTriggerSource" NOT NULL,
    "label" TEXT NOT NULL,
    "payload" TEXT,
    "payloadType" TEXT NOT NULL DEFAULT 'application/json',
    "metadata" TEXT,
    "metadataType" TEXT NOT NULL DEFAULT 'application/json',
    "queue" TEXT,
    "concurrencyKey" TEXT,
    "ttlSeconds" INTEGER,
    "maxAttempts" INTEGER,
    "maxDurationSeconds" INTEGER,
    "tags" TEXT[],
    "machinePreset" TEXT,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunExecutionSnapshot" (
    "id" TEXT NOT NULL,
    "engine" "public"."RunEngineVersion" NOT NULL DEFAULT 'V2',
    "executionStatus" "public"."TaskRunExecutionStatus" NOT NULL,
    "description" TEXT NOT NULL,
    "isValid" BOOLEAN NOT NULL DEFAULT true,
    "error" TEXT,
    "previousSnapshotId" TEXT,
    "runId" TEXT NOT NULL,
    "runStatus" "public"."TaskRunStatus" NOT NULL,
    "batchId" TEXT,
    "attemptNumber" INTEGER,
    "environmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType" NOT NULL,
    "projectId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "completedWaitpointOrder" TEXT[],
    "checkpointId" TEXT,
    "workerId" TEXT,
    "runnerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastHeartbeatAt" TIMESTAMP(3),
    "metadata" JSONB,

    CONSTRAINT "TaskRunExecutionSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunCheckpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "public"."TaskRunCheckpointType" NOT NULL,
    "location" TEXT NOT NULL,
    "imageRef" TEXT,
    "reason" TEXT,
    "metadata" TEXT,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Waitpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "public"."WaitpointType" NOT NULL,
    "status" "public"."WaitpointStatus" NOT NULL DEFAULT 'PENDING',
    "completedAt" TIMESTAMP(3),
    "idempotencyKey" TEXT NOT NULL,
    "userProvidedIdempotencyKey" BOOLEAN NOT NULL,
    "idempotencyKeyExpiresAt" TIMESTAMP(3),
    "inactiveIdempotencyKey" TEXT,
    "completedByTaskRunId" TEXT,
    "completedAfter" TIMESTAMP(3),
    "completedByBatchId" TEXT,
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',
    "outputIsError" BOOLEAN NOT NULL DEFAULT false,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[],

    CONSTRAINT "Waitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunWaitpoint" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "waitpointId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "spanIdToComplete" TEXT,
    "batchId" TEXT,
    "batchIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskRunWaitpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WaitpointTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaitpointTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."FeatureFlag" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkerInstance" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "resourceIdentifier" TEXT NOT NULL,
    "metadata" JSONB,
    "workerGroupId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "environmentId" TEXT,
    "deploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastDequeueAt" TIMESTAMP(3),
    "lastHeartbeatAt" TIMESTAMP(3),

    CONSTRAINT "WorkerInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkerInstanceGroup" (
    "id" TEXT NOT NULL,
    "type" "public"."WorkerInstanceGroupType" NOT NULL,
    "name" TEXT NOT NULL,
    "masterQueue" TEXT NOT NULL,
    "description" TEXT,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "tokenId" TEXT NOT NULL,
    "organizationId" TEXT,
    "projectId" TEXT,
    "cloudProvider" TEXT,
    "location" TEXT,
    "staticIPs" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerInstanceGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkerGroupToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerGroupToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunTag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskRunTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunDependency" (
    "id" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "checkpointEventId" TEXT,
    "dependentAttemptId" TEXT,
    "dependentBatchRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resumedAt" TIMESTAMP(3),

    CONSTRAINT "TaskRunDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunCounter" (
    "taskIdentifier" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaskRunCounter_pkey" PRIMARY KEY ("taskIdentifier")
);

-- CreateTable
CREATE TABLE "public"."TaskRunNumberCounter" (
    "id" TEXT NOT NULL,
    "taskIdentifier" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "lastNumber" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "TaskRunNumberCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskRunAttempt" (
    "id" TEXT NOT NULL,
    "number" INTEGER NOT NULL DEFAULT 0,
    "friendlyId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "backgroundWorkerId" TEXT NOT NULL,
    "backgroundWorkerTaskId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "queueId" TEXT NOT NULL,
    "status" "public"."TaskRunAttemptStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "usageDurationMs" INTEGER NOT NULL DEFAULT 0,
    "error" JSONB,
    "output" TEXT,
    "outputType" TEXT NOT NULL DEFAULT 'application/json',

    CONSTRAINT "TaskRunAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskEvent" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "parentId" TEXT,
    "tracestate" TEXT,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "isDebug" BOOLEAN NOT NULL DEFAULT false,
    "serviceName" TEXT NOT NULL,
    "serviceNamespace" TEXT NOT NULL,
    "level" "public"."TaskEventLevel" NOT NULL DEFAULT 'TRACE',
    "kind" "public"."TaskEventKind" NOT NULL DEFAULT 'INTERNAL',
    "status" "public"."TaskEventStatus" NOT NULL DEFAULT 'UNSET',
    "links" JSONB,
    "events" JSONB,
    "startTime" BIGINT NOT NULL,
    "duration" BIGINT NOT NULL DEFAULT 0,
    "attemptId" TEXT,
    "attemptNumber" INTEGER,
    "environmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectRef" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "runIsTest" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "taskSlug" TEXT NOT NULL,
    "taskPath" TEXT,
    "taskExportName" TEXT,
    "workerId" TEXT,
    "workerVersion" TEXT,
    "queueId" TEXT,
    "queueName" TEXT,
    "batchId" TEXT,
    "properties" JSONB NOT NULL,
    "metadata" JSONB,
    "style" JSONB,
    "output" JSONB,
    "outputType" TEXT,
    "payload" JSONB,
    "payloadType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usageDurationMs" INTEGER NOT NULL DEFAULT 0,
    "usageCostInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "machinePreset" TEXT,
    "machinePresetCpu" DOUBLE PRECISION,
    "machinePresetMemory" DOUBLE PRECISION,
    "machinePresetCentsPerMs" DOUBLE PRECISION,

    CONSTRAINT "TaskEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskQueue" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "public"."TaskQueueType" NOT NULL DEFAULT 'VIRTUAL',
    "version" "public"."TaskQueueVersion" NOT NULL DEFAULT 'V1',
    "orderableName" TEXT,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "concurrencyLimit" INTEGER,
    "rateLimit" JSONB,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaskQueue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BatchTaskRun" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "idempotencyKey" TEXT,
    "idempotencyKeyExpiresAt" TIMESTAMP(3),
    "status" "public"."BatchTaskRunStatus" NOT NULL DEFAULT 'PENDING',
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "runIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "payload" TEXT,
    "payloadType" TEXT NOT NULL DEFAULT 'application/json',
    "options" JSONB,
    "batchVersion" TEXT NOT NULL DEFAULT 'v1',
    "sealed" BOOLEAN NOT NULL DEFAULT false,
    "sealedAt" TIMESTAMP(3),
    "expectedCount" INTEGER NOT NULL DEFAULT 0,
    "completedCount" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "resumedAt" TIMESTAMP(3),
    "processingJobsCount" INTEGER NOT NULL DEFAULT 0,
    "processingJobsExpectedCount" INTEGER NOT NULL DEFAULT 0,
    "oneTimeUseToken" TEXT,
    "taskIdentifier" TEXT,
    "checkpointEventId" TEXT,
    "dependentTaskAttemptId" TEXT,

    CONSTRAINT "BatchTaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BatchTaskRunItem" (
    "id" TEXT NOT NULL,
    "status" "public"."BatchTaskRunItemStatus" NOT NULL DEFAULT 'PENDING',
    "batchTaskRunId" TEXT NOT NULL,
    "taskRunId" TEXT NOT NULL,
    "taskRunAttemptId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BatchTaskRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EnvironmentVariable" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentVariable_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."EnvironmentVariableValue" (
    "id" TEXT NOT NULL,
    "valueReferenceId" TEXT,
    "variableId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "isSecret" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnvironmentVariableValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Checkpoint" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "type" "public"."CheckpointType" NOT NULL,
    "location" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "attemptNumber" INTEGER,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."CheckpointRestoreEvent" (
    "id" TEXT NOT NULL,
    "type" "public"."CheckpointRestoreEventType" NOT NULL,
    "reason" TEXT,
    "metadata" TEXT,
    "checkpointId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "runtimeEnvironmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CheckpointRestoreEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkerDeployment" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "shortCode" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "runtime" TEXT,
    "runtimeVersion" TEXT,
    "imageReference" TEXT,
    "imagePlatform" TEXT NOT NULL DEFAULT 'linux/amd64',
    "externalBuildData" JSONB,
    "status" "public"."WorkerDeploymentStatus" NOT NULL DEFAULT 'PENDING',
    "type" "public"."WorkerDeploymentType" NOT NULL DEFAULT 'V1',
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "workerId" TEXT,
    "triggeredById" TEXT,
    "builtAt" TIMESTAMP(3),
    "deployedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorData" JSONB,
    "git" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkerDeployment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."WorkerDeploymentPromotion" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "deploymentId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,

    CONSTRAINT "WorkerDeploymentPromotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskSchedule" (
    "id" TEXT NOT NULL,
    "type" "public"."ScheduleType" NOT NULL DEFAULT 'IMPERATIVE',
    "friendlyId" TEXT NOT NULL,
    "taskIdentifier" TEXT NOT NULL,
    "deduplicationKey" TEXT NOT NULL,
    "userProvidedDeduplicationKey" BOOLEAN NOT NULL DEFAULT false,
    "generatorExpression" TEXT NOT NULL,
    "generatorDescription" TEXT NOT NULL DEFAULT '',
    "generatorType" "public"."ScheduleGeneratorType" NOT NULL DEFAULT 'CRON',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "externalId" TEXT,
    "lastRunTriggeredAt" TIMESTAMP(3),
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "TaskSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskScheduleInstance" (
    "id" TEXT NOT NULL,
    "taskScheduleId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "lastScheduledTimestamp" TIMESTAMP(3),
    "nextScheduledTimestamp" TIMESTAMP(3),

    CONSTRAINT "TaskScheduleInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RuntimeEnvironmentSession" (
    "id" TEXT NOT NULL,
    "ipAddress" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "RuntimeEnvironmentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProjectAlertChannel" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "deduplicationKey" TEXT NOT NULL,
    "userProvidedDeduplicationKey" BOOLEAN NOT NULL DEFAULT false,
    "integrationId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "type" "public"."ProjectAlertChannelType" NOT NULL,
    "name" TEXT NOT NULL,
    "properties" JSONB NOT NULL,
    "alertTypes" "public"."ProjectAlertType"[],
    "environmentTypes" "public"."RuntimeEnvironmentType"[] DEFAULT ARRAY['STAGING', 'PRODUCTION']::"public"."RuntimeEnvironmentType"[],
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAlertChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProjectAlert" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "status" "public"."ProjectAlertStatus" NOT NULL DEFAULT 'PENDING',
    "type" "public"."ProjectAlertType" NOT NULL,
    "taskRunAttemptId" TEXT,
    "taskRunId" TEXT,
    "workerDeploymentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ProjectAlertStorage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "alertChannelId" TEXT NOT NULL,
    "alertType" "public"."ProjectAlertType" NOT NULL,
    "storageId" TEXT NOT NULL,
    "storageData" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectAlertStorage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."OrganizationIntegration" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "service" "public"."IntegrationService" NOT NULL,
    "integrationData" JSONB NOT NULL,
    "tokenReferenceId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizationIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BulkActionGroup" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "environmentId" TEXT,
    "type" "public"."BulkActionType" NOT NULL,
    "status" "public"."BulkActionStatus" NOT NULL DEFAULT 'PENDING',
    "queryName" TEXT,
    "params" JSONB,
    "cursor" JSONB,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "completionNotification" "public"."BulkActionNotificationType" NOT NULL DEFAULT 'NONE',
    "userId" TEXT,
    "name" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionGroup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."BulkActionItem" (
    "id" TEXT NOT NULL,
    "friendlyId" TEXT,
    "groupId" TEXT NOT NULL,
    "type" "public"."BulkActionType" NOT NULL,
    "status" "public"."BulkActionItemStatus" NOT NULL DEFAULT 'PENDING',
    "sourceRunId" TEXT NOT NULL,
    "destinationRunId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BulkActionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."RealtimeStreamChunk" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealtimeStreamChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."TaskEventPartitioned" (
    "id" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "traceId" TEXT NOT NULL,
    "spanId" TEXT NOT NULL,
    "parentId" TEXT,
    "tracestate" TEXT,
    "isError" BOOLEAN NOT NULL DEFAULT false,
    "isPartial" BOOLEAN NOT NULL DEFAULT false,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "serviceName" TEXT NOT NULL,
    "serviceNamespace" TEXT NOT NULL,
    "level" "public"."TaskEventLevel" NOT NULL DEFAULT 'TRACE',
    "kind" "public"."TaskEventKind" NOT NULL DEFAULT 'INTERNAL',
    "status" "public"."TaskEventStatus" NOT NULL DEFAULT 'UNSET',
    "links" JSONB,
    "events" JSONB,
    "startTime" BIGINT NOT NULL,
    "duration" BIGINT NOT NULL DEFAULT 0,
    "attemptId" TEXT,
    "attemptNumber" INTEGER,
    "environmentId" TEXT NOT NULL,
    "environmentType" "public"."RuntimeEnvironmentType" NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "projectRef" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "runIsTest" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT,
    "taskSlug" TEXT NOT NULL,
    "taskPath" TEXT,
    "taskExportName" TEXT,
    "workerId" TEXT,
    "workerVersion" TEXT,
    "queueId" TEXT,
    "queueName" TEXT,
    "batchId" TEXT,
    "properties" JSONB NOT NULL,
    "metadata" JSONB,
    "style" JSONB,
    "output" JSONB,
    "outputType" TEXT,
    "payload" JSONB,
    "payloadType" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "usageDurationMs" INTEGER NOT NULL DEFAULT 0,
    "usageCostInCents" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "machinePreset" TEXT,
    "machinePresetCpu" DOUBLE PRECISION,
    "machinePresetMemory" DOUBLE PRECISION,
    "machinePresetCentsPerMs" DOUBLE PRECISION,

    CONSTRAINT "TaskEventPartitioned_pkey" PRIMARY KEY ("id","createdAt")
);

-- CreateTable
CREATE TABLE "public"."_BackgroundWorkerToBackgroundWorkerFile" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_BackgroundWorkerToTaskQueue" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_BackgroundWorkerToTaskQueue_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_TaskRunToTaskRunTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_TaskRunToTaskRunTag_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_WaitpointRunConnections" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_WaitpointRunConnections_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateTable
CREATE TABLE "public"."_completedWaitpoints" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,

    CONSTRAINT "_completedWaitpoints_AB_pkey" PRIMARY KEY ("A","B")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "public"."User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_authIdentifier_key" ON "public"."User"("authIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "MfaBackupCode_userId_code_key" ON "public"."MfaBackupCode"("userId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "InvitationCode_code_key" ON "public"."InvitationCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "AuthorizationCode_code_key" ON "public"."AuthorizationCode"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PersonalAccessToken_hashedToken_key" ON "public"."PersonalAccessToken"("hashedToken");

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "public"."Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMember_organizationId_userId_key" ON "public"."OrgMember"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMemberInvite_token_key" ON "public"."OrgMemberInvite"("token");

-- CreateIndex
CREATE UNIQUE INDEX "OrgMemberInvite_organizationId_email_key" ON "public"."OrgMemberInvite"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEnvironment_apiKey_key" ON "public"."RuntimeEnvironment"("apiKey");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEnvironment_pkApiKey_key" ON "public"."RuntimeEnvironment"("pkApiKey");

-- CreateIndex
CREATE INDEX "RuntimeEnvironment_parentEnvironmentId_idx" ON "public"."RuntimeEnvironment"("parentEnvironmentId");

-- CreateIndex
CREATE INDEX "RuntimeEnvironment_projectId_idx" ON "public"."RuntimeEnvironment"("projectId");

-- CreateIndex
CREATE INDEX "RuntimeEnvironment_organizationId_idx" ON "public"."RuntimeEnvironment"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEnvironment_projectId_slug_orgMemberId_key" ON "public"."RuntimeEnvironment"("projectId", "slug", "orgMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEnvironment_projectId_shortcode_key" ON "public"."RuntimeEnvironment"("projectId", "shortcode");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "public"."Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Project_externalRef_key" ON "public"."Project"("externalRef");

-- CreateIndex
CREATE UNIQUE INDEX "SecretReference_key_key" ON "public"."SecretReference"("key");

-- CreateIndex
CREATE UNIQUE INDEX "SecretStore_key_key" ON "public"."SecretStore"("key");

-- CreateIndex
CREATE INDEX "SecretStore_key_idx" ON "public"."SecretStore"("key" text_pattern_ops);

-- CreateIndex
CREATE UNIQUE INDEX "DataMigration_name_key" ON "public"."DataMigration"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorker_friendlyId_key" ON "public"."BackgroundWorker"("friendlyId");

-- CreateIndex
CREATE INDEX "BackgroundWorker_runtimeEnvironmentId_idx" ON "public"."BackgroundWorker"("runtimeEnvironmentId");

-- CreateIndex
CREATE INDEX "BackgroundWorker_runtimeEnvironmentId_createdAt_idx" ON "public"."BackgroundWorker"("runtimeEnvironmentId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorker_projectId_runtimeEnvironmentId_version_key" ON "public"."BackgroundWorker"("projectId", "runtimeEnvironmentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerFile_friendlyId_key" ON "public"."BackgroundWorkerFile"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerFile_projectId_contentHash_key" ON "public"."BackgroundWorkerFile"("projectId", "contentHash");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerTask_friendlyId_key" ON "public"."BackgroundWorkerTask"("friendlyId");

-- CreateIndex
CREATE INDEX "BackgroundWorkerTask_projectId_slug_idx" ON "public"."BackgroundWorkerTask"("projectId", "slug");

-- CreateIndex
CREATE INDEX "BackgroundWorkerTask_runtimeEnvironmentId_projectId_idx" ON "public"."BackgroundWorkerTask"("runtimeEnvironmentId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundWorkerTask_workerId_slug_key" ON "public"."BackgroundWorkerTask"("workerId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_friendlyId_key" ON "public"."TaskRun"("friendlyId");

-- CreateIndex
CREATE INDEX "TaskRun_parentTaskRunId_idx" ON "public"."TaskRun"("parentTaskRunId");

-- CreateIndex
CREATE INDEX "TaskRun_rootTaskRunId_idx" ON "public"."TaskRun"("rootTaskRunId");

-- CreateIndex
CREATE INDEX "TaskRun_scheduleId_idx" ON "public"."TaskRun"("scheduleId");

-- CreateIndex
CREATE INDEX "TaskRun_spanId_idx" ON "public"."TaskRun"("spanId");

-- CreateIndex
CREATE INDEX "TaskRun_parentSpanId_idx" ON "public"."TaskRun"("parentSpanId");

-- CreateIndex
CREATE INDEX "TaskRun_scheduleId_createdAt_idx" ON "public"."TaskRun"("scheduleId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runTags_idx" ON "public"."TaskRun" USING GIN ("runTags" array_ops);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_batchId_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "batchId");

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_id_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "id" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_runtimeEnvironmentId_createdAt_idx" ON "public"."TaskRun"("runtimeEnvironmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TaskRun_createdAt_idx" ON "public"."TaskRun" USING BRIN ("createdAt");

-- CreateIndex
CREATE INDEX "TaskRun_status_runtimeEnvironmentId_createdAt_id_idx" ON "public"."TaskRun"("status", "runtimeEnvironmentId", "createdAt", "id" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_oneTimeUseToken_key" ON "public"."TaskRun"("oneTimeUseToken");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRun_runtimeEnvironmentId_taskIdentifier_idempotencyKey_key" ON "public"."TaskRun"("runtimeEnvironmentId", "taskIdentifier", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TaskRunTemplate_projectId_taskSlug_triggerSource_createdAt_idx" ON "public"."TaskRunTemplate"("projectId", "taskSlug", "triggerSource", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "TaskRunExecutionSnapshot_runId_isValid_createdAt_idx" ON "public"."TaskRunExecutionSnapshot"("runId", "isValid", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunCheckpoint_friendlyId_key" ON "public"."TaskRunCheckpoint"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_friendlyId_key" ON "public"."Waitpoint"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_completedByTaskRunId_key" ON "public"."Waitpoint"("completedByTaskRunId");

-- CreateIndex
CREATE INDEX "Waitpoint_completedByBatchId_idx" ON "public"."Waitpoint"("completedByBatchId");

-- CreateIndex
CREATE INDEX "Waitpoint_environmentId_type_createdAt_idx" ON "public"."Waitpoint"("environmentId", "type", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "Waitpoint_environmentId_type_status_idx" ON "public"."Waitpoint"("environmentId", "type", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Waitpoint_environmentId_idempotencyKey_key" ON "public"."Waitpoint"("environmentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "TaskRunWaitpoint_taskRunId_idx" ON "public"."TaskRunWaitpoint"("taskRunId");

-- CreateIndex
CREATE INDEX "TaskRunWaitpoint_waitpointId_idx" ON "public"."TaskRunWaitpoint"("waitpointId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunWaitpoint_taskRunId_waitpointId_batchIndex_key" ON "public"."TaskRunWaitpoint"("taskRunId", "waitpointId", "batchIndex");

-- CreateIndex
CREATE UNIQUE INDEX "WaitpointTag_environmentId_name_key" ON "public"."WaitpointTag"("environmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlag_key_key" ON "public"."FeatureFlag"("key");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerInstance_workerGroupId_resourceIdentifier_key" ON "public"."WorkerInstance"("workerGroupId", "resourceIdentifier");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerInstanceGroup_masterQueue_key" ON "public"."WorkerInstanceGroup"("masterQueue");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerInstanceGroup_tokenId_key" ON "public"."WorkerInstanceGroup"("tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerGroupToken_tokenHash_key" ON "public"."WorkerGroupToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunTag_friendlyId_key" ON "public"."TaskRunTag"("friendlyId");

-- CreateIndex
CREATE INDEX "TaskRunTag_name_id_idx" ON "public"."TaskRunTag"("name", "id");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunTag_projectId_name_key" ON "public"."TaskRunTag"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunDependency_taskRunId_key" ON "public"."TaskRunDependency"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunDependency_checkpointEventId_key" ON "public"."TaskRunDependency"("checkpointEventId");

-- CreateIndex
CREATE INDEX "TaskRunDependency_dependentAttemptId_idx" ON "public"."TaskRunDependency"("dependentAttemptId");

-- CreateIndex
CREATE INDEX "TaskRunDependency_dependentBatchRunId_idx" ON "public"."TaskRunDependency"("dependentBatchRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunNumberCounter_taskIdentifier_environmentId_key" ON "public"."TaskRunNumberCounter"("taskIdentifier", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunAttempt_friendlyId_key" ON "public"."TaskRunAttempt"("friendlyId");

-- CreateIndex
CREATE INDEX "TaskRunAttempt_taskRunId_idx" ON "public"."TaskRunAttempt"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskRunAttempt_taskRunId_number_key" ON "public"."TaskRunAttempt"("taskRunId", "number");

-- CreateIndex
CREATE INDEX "TaskEvent_traceId_idx" ON "public"."TaskEvent"("traceId");

-- CreateIndex
CREATE INDEX "TaskEvent_spanId_idx" ON "public"."TaskEvent"("spanId");

-- CreateIndex
CREATE INDEX "TaskEvent_runId_idx" ON "public"."TaskEvent"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskQueue_friendlyId_key" ON "public"."TaskQueue"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskQueue_runtimeEnvironmentId_name_key" ON "public"."TaskQueue"("runtimeEnvironmentId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_friendlyId_key" ON "public"."BatchTaskRun"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_checkpointEventId_key" ON "public"."BatchTaskRun"("checkpointEventId");

-- CreateIndex
CREATE INDEX "BatchTaskRun_dependentTaskAttemptId_idx" ON "public"."BatchTaskRun"("dependentTaskAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_oneTimeUseToken_key" ON "public"."BatchTaskRun"("oneTimeUseToken");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRun_runtimeEnvironmentId_idempotencyKey_key" ON "public"."BatchTaskRun"("runtimeEnvironmentId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "idx_batchtaskrunitem_taskrunattempt" ON "public"."BatchTaskRunItem"("taskRunAttemptId");

-- CreateIndex
CREATE INDEX "idx_batchtaskrunitem_taskrun" ON "public"."BatchTaskRunItem"("taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "BatchTaskRunItem_batchTaskRunId_taskRunId_key" ON "public"."BatchTaskRunItem"("batchTaskRunId", "taskRunId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariable_friendlyId_key" ON "public"."EnvironmentVariable"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariable_projectId_key_key" ON "public"."EnvironmentVariable"("projectId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "EnvironmentVariableValue_variableId_environmentId_key" ON "public"."EnvironmentVariableValue"("variableId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Checkpoint_friendlyId_key" ON "public"."Checkpoint"("friendlyId");

-- CreateIndex
CREATE INDEX "Checkpoint_attemptId_idx" ON "public"."Checkpoint"("attemptId");

-- CreateIndex
CREATE INDEX "Checkpoint_runId_idx" ON "public"."Checkpoint"("runId");

-- CreateIndex
CREATE INDEX "CheckpointRestoreEvent_checkpointId_idx" ON "public"."CheckpointRestoreEvent"("checkpointId");

-- CreateIndex
CREATE INDEX "CheckpointRestoreEvent_runId_idx" ON "public"."CheckpointRestoreEvent"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_friendlyId_key" ON "public"."WorkerDeployment"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_workerId_key" ON "public"."WorkerDeployment"("workerId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_projectId_shortCode_key" ON "public"."WorkerDeployment"("projectId", "shortCode");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeployment_environmentId_version_key" ON "public"."WorkerDeployment"("environmentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "WorkerDeploymentPromotion_environmentId_label_key" ON "public"."WorkerDeploymentPromotion"("environmentId", "label");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSchedule_friendlyId_key" ON "public"."TaskSchedule"("friendlyId");

-- CreateIndex
CREATE INDEX "TaskSchedule_projectId_idx" ON "public"."TaskSchedule"("projectId");

-- CreateIndex
CREATE INDEX "TaskSchedule_projectId_createdAt_idx" ON "public"."TaskSchedule"("projectId", "createdAt" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "TaskSchedule_projectId_deduplicationKey_key" ON "public"."TaskSchedule"("projectId", "deduplicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "TaskScheduleInstance_taskScheduleId_environmentId_key" ON "public"."TaskScheduleInstance"("taskScheduleId", "environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAlertChannel_friendlyId_key" ON "public"."ProjectAlertChannel"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAlertChannel_projectId_deduplicationKey_key" ON "public"."ProjectAlertChannel"("projectId", "deduplicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectAlert_friendlyId_key" ON "public"."ProjectAlert"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationIntegration_friendlyId_key" ON "public"."OrganizationIntegration"("friendlyId");

-- CreateIndex
CREATE UNIQUE INDEX "BulkActionGroup_friendlyId_key" ON "public"."BulkActionGroup"("friendlyId");

-- CreateIndex
CREATE INDEX "BulkActionGroup_environmentId_createdAt_idx" ON "public"."BulkActionGroup"("environmentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "RealtimeStreamChunk_runId_idx" ON "public"."RealtimeStreamChunk"("runId");

-- CreateIndex
CREATE INDEX "RealtimeStreamChunk_createdAt_idx" ON "public"."RealtimeStreamChunk"("createdAt");

-- CreateIndex
CREATE INDEX "TaskEventPartitioned_traceId_idx" ON "public"."TaskEventPartitioned"("traceId");

-- CreateIndex
CREATE INDEX "TaskEventPartitioned_spanId_idx" ON "public"."TaskEventPartitioned"("spanId");

-- CreateIndex
CREATE INDEX "TaskEventPartitioned_runId_idx" ON "public"."TaskEventPartitioned"("runId");

-- CreateIndex
CREATE INDEX "_BackgroundWorkerToBackgroundWorkerFile_B_index" ON "public"."_BackgroundWorkerToBackgroundWorkerFile"("B");

-- CreateIndex
CREATE INDEX "_BackgroundWorkerToTaskQueue_B_index" ON "public"."_BackgroundWorkerToTaskQueue"("B");

-- CreateIndex
CREATE INDEX "_TaskRunToTaskRunTag_B_index" ON "public"."_TaskRunToTaskRunTag"("B");

-- CreateIndex
CREATE INDEX "_WaitpointRunConnections_B_index" ON "public"."_WaitpointRunConnections"("B");

-- CreateIndex
CREATE INDEX "_completedWaitpoints_B_index" ON "public"."_completedWaitpoints"("B");

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_mfaSecretReferenceId_fkey" FOREIGN KEY ("mfaSecretReferenceId") REFERENCES "public"."SecretReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."User" ADD CONSTRAINT "User_invitationCodeId_fkey" FOREIGN KEY ("invitationCodeId") REFERENCES "public"."InvitationCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."MfaBackupCode" ADD CONSTRAINT "MfaBackupCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."AuthorizationCode" ADD CONSTRAINT "AuthorizationCode_personalAccessTokenId_fkey" FOREIGN KEY ("personalAccessTokenId") REFERENCES "public"."PersonalAccessToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."PersonalAccessToken" ADD CONSTRAINT "PersonalAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrgMember" ADD CONSTRAINT "OrgMember_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrgMember" ADD CONSTRAINT "OrgMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrgMemberInvite" ADD CONSTRAINT "OrgMemberInvite_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrgMemberInvite" ADD CONSTRAINT "OrgMemberInvite_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "public"."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_parentEnvironmentId_fkey" FOREIGN KEY ("parentEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_orgMemberId_fkey" FOREIGN KEY ("orgMemberId") REFERENCES "public"."OrgMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RuntimeEnvironment" ADD CONSTRAINT "RuntimeEnvironment_currentSessionId_fkey" FOREIGN KEY ("currentSessionId") REFERENCES "public"."RuntimeEnvironmentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Project" ADD CONSTRAINT "Project_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Project" ADD CONSTRAINT "Project_defaultWorkerGroupId_fkey" FOREIGN KEY ("defaultWorkerGroupId") REFERENCES "public"."WorkerInstanceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorker" ADD CONSTRAINT "BackgroundWorker_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorker" ADD CONSTRAINT "BackgroundWorker_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorker" ADD CONSTRAINT "BackgroundWorker_workerGroupId_fkey" FOREIGN KEY ("workerGroupId") REFERENCES "public"."WorkerInstanceGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorkerFile" ADD CONSTRAINT "BackgroundWorkerFile_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "public"."BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_fileId_fkey" FOREIGN KEY ("fileId") REFERENCES "public"."BackgroundWorkerFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BackgroundWorkerTask" ADD CONSTRAINT "BackgroundWorkerTask_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "public"."TaskQueue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_lockedById_fkey" FOREIGN KEY ("lockedById") REFERENCES "public"."BackgroundWorkerTask"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_lockedToVersionId_fkey" FOREIGN KEY ("lockedToVersionId") REFERENCES "public"."BackgroundWorker"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_rootTaskRunId_fkey" FOREIGN KEY ("rootTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunId_fkey" FOREIGN KEY ("parentTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_parentTaskRunAttemptId_fkey" FOREIGN KEY ("parentTaskRunAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRun" ADD CONSTRAINT "TaskRun_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "public"."TaskRunCheckpoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunExecutionSnapshot" ADD CONSTRAINT "TaskRunExecutionSnapshot_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "public"."WorkerInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunCheckpoint" ADD CONSTRAINT "TaskRunCheckpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunCheckpoint" ADD CONSTRAINT "TaskRunCheckpoint_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Waitpoint" ADD CONSTRAINT "Waitpoint_completedByTaskRunId_fkey" FOREIGN KEY ("completedByTaskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Waitpoint" ADD CONSTRAINT "Waitpoint_completedByBatchId_fkey" FOREIGN KEY ("completedByBatchId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Waitpoint" ADD CONSTRAINT "Waitpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Waitpoint" ADD CONSTRAINT "Waitpoint_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_waitpointId_fkey" FOREIGN KEY ("waitpointId") REFERENCES "public"."Waitpoint"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunWaitpoint" ADD CONSTRAINT "TaskRunWaitpoint_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WaitpointTag" ADD CONSTRAINT "WaitpointTag_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WaitpointTag" ADD CONSTRAINT "WaitpointTag_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstance" ADD CONSTRAINT "WorkerInstance_workerGroupId_fkey" FOREIGN KEY ("workerGroupId") REFERENCES "public"."WorkerInstanceGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstance" ADD CONSTRAINT "WorkerInstance_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstance" ADD CONSTRAINT "WorkerInstance_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstance" ADD CONSTRAINT "WorkerInstance_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstance" ADD CONSTRAINT "WorkerInstance_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "public"."WorkerDeployment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstanceGroup" ADD CONSTRAINT "WorkerInstanceGroup_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "public"."WorkerGroupToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstanceGroup" ADD CONSTRAINT "WorkerInstanceGroup_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerInstanceGroup" ADD CONSTRAINT "WorkerInstanceGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunTag" ADD CONSTRAINT "TaskRunTag_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_checkpointEventId_fkey" FOREIGN KEY ("checkpointEventId") REFERENCES "public"."CheckpointRestoreEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_dependentAttemptId_fkey" FOREIGN KEY ("dependentAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunDependency" ADD CONSTRAINT "TaskRunDependency_dependentBatchRunId_fkey" FOREIGN KEY ("dependentBatchRunId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunNumberCounter" ADD CONSTRAINT "TaskRunNumberCounter_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_backgroundWorkerId_fkey" FOREIGN KEY ("backgroundWorkerId") REFERENCES "public"."BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_backgroundWorkerTaskId_fkey" FOREIGN KEY ("backgroundWorkerTaskId") REFERENCES "public"."BackgroundWorkerTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskRunAttempt" ADD CONSTRAINT "TaskRunAttempt_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "public"."TaskQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskQueue" ADD CONSTRAINT "TaskQueue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskQueue" ADD CONSTRAINT "TaskQueue_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_checkpointEventId_fkey" FOREIGN KEY ("checkpointEventId") REFERENCES "public"."CheckpointRestoreEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRun" ADD CONSTRAINT "BatchTaskRun_dependentTaskAttemptId_fkey" FOREIGN KEY ("dependentTaskAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_batchTaskRunId_fkey" FOREIGN KEY ("batchTaskRunId") REFERENCES "public"."BatchTaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BatchTaskRunItem" ADD CONSTRAINT "BatchTaskRunItem_taskRunAttemptId_fkey" FOREIGN KEY ("taskRunAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentVariable" ADD CONSTRAINT "EnvironmentVariable_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentVariableValue" ADD CONSTRAINT "EnvironmentVariableValue_valueReferenceId_fkey" FOREIGN KEY ("valueReferenceId") REFERENCES "public"."SecretReference"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentVariableValue" ADD CONSTRAINT "EnvironmentVariableValue_variableId_fkey" FOREIGN KEY ("variableId") REFERENCES "public"."EnvironmentVariable"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."EnvironmentVariableValue" ADD CONSTRAINT "EnvironmentVariableValue_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Checkpoint" ADD CONSTRAINT "Checkpoint_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Checkpoint" ADD CONSTRAINT "Checkpoint_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Checkpoint" ADD CONSTRAINT "Checkpoint_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Checkpoint" ADD CONSTRAINT "Checkpoint_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_checkpointId_fkey" FOREIGN KEY ("checkpointId") REFERENCES "public"."Checkpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."CheckpointRestoreEvent" ADD CONSTRAINT "CheckpointRestoreEvent_runtimeEnvironmentId_fkey" FOREIGN KEY ("runtimeEnvironmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "public"."BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerDeployment" ADD CONSTRAINT "WorkerDeployment_triggeredById_fkey" FOREIGN KEY ("triggeredById") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerDeploymentPromotion" ADD CONSTRAINT "WorkerDeploymentPromotion_deploymentId_fkey" FOREIGN KEY ("deploymentId") REFERENCES "public"."WorkerDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."WorkerDeploymentPromotion" ADD CONSTRAINT "WorkerDeploymentPromotion_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskSchedule" ADD CONSTRAINT "TaskSchedule_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskScheduleInstance" ADD CONSTRAINT "TaskScheduleInstance_taskScheduleId_fkey" FOREIGN KEY ("taskScheduleId") REFERENCES "public"."TaskSchedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."TaskScheduleInstance" ADD CONSTRAINT "TaskScheduleInstance_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."RuntimeEnvironmentSession" ADD CONSTRAINT "RuntimeEnvironmentSession_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlertChannel" ADD CONSTRAINT "ProjectAlertChannel_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "public"."OrganizationIntegration"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlertChannel" ADD CONSTRAINT "ProjectAlertChannel_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlert" ADD CONSTRAINT "ProjectAlert_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlert" ADD CONSTRAINT "ProjectAlert_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlert" ADD CONSTRAINT "ProjectAlert_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "public"."ProjectAlertChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlert" ADD CONSTRAINT "ProjectAlert_taskRunAttemptId_fkey" FOREIGN KEY ("taskRunAttemptId") REFERENCES "public"."TaskRunAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlert" ADD CONSTRAINT "ProjectAlert_taskRunId_fkey" FOREIGN KEY ("taskRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlert" ADD CONSTRAINT "ProjectAlert_workerDeploymentId_fkey" FOREIGN KEY ("workerDeploymentId") REFERENCES "public"."WorkerDeployment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlertStorage" ADD CONSTRAINT "ProjectAlertStorage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ProjectAlertStorage" ADD CONSTRAINT "ProjectAlertStorage_alertChannelId_fkey" FOREIGN KEY ("alertChannelId") REFERENCES "public"."ProjectAlertChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationIntegration" ADD CONSTRAINT "OrganizationIntegration_tokenReferenceId_fkey" FOREIGN KEY ("tokenReferenceId") REFERENCES "public"."SecretReference"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."OrganizationIntegration" ADD CONSTRAINT "OrganizationIntegration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BulkActionGroup" ADD CONSTRAINT "BulkActionGroup_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "public"."Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BulkActionGroup" ADD CONSTRAINT "BulkActionGroup_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "public"."RuntimeEnvironment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BulkActionGroup" ADD CONSTRAINT "BulkActionGroup_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BulkActionItem" ADD CONSTRAINT "BulkActionItem_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."BulkActionGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BulkActionItem" ADD CONSTRAINT "BulkActionItem_sourceRunId_fkey" FOREIGN KEY ("sourceRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."BulkActionItem" ADD CONSTRAINT "BulkActionItem_destinationRunId_fkey" FOREIGN KEY ("destinationRunId") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BackgroundWorkerToBackgroundWorkerFile" ADD CONSTRAINT "_BackgroundWorkerToBackgroundWorkerFile_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."BackgroundWorkerFile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BackgroundWorkerToTaskQueue" ADD CONSTRAINT "_BackgroundWorkerToTaskQueue_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."BackgroundWorker"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_BackgroundWorkerToTaskQueue" ADD CONSTRAINT "_BackgroundWorkerToTaskQueue_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."TaskQueue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_TaskRunToTaskRunTag" ADD CONSTRAINT "_TaskRunToTaskRunTag_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."TaskRunTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_WaitpointRunConnections" ADD CONSTRAINT "_WaitpointRunConnections_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Waitpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_A_fkey" FOREIGN KEY ("A") REFERENCES "public"."TaskRunExecutionSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."_completedWaitpoints" ADD CONSTRAINT "_completedWaitpoints_B_fkey" FOREIGN KEY ("B") REFERENCES "public"."Waitpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

