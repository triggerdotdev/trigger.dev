/*
  Warnings:

  - You are about to drop the `JobCounter` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WebhookDeliveryCounter` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ApiIntegrationVote` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `ConnectionAttempt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DeferredScheduledEventService` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DynamicTriggerRegistration` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EndpointIndex` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `EventExample` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `HttpSourceRequestDelivery` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobAlias` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobIntegration` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobRunAutoYieldExecution` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobRunStatusRecord` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `JobRunSubscription` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `KeyValueItem` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `MissingConnection` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TaskAttempt` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `TriggerSourceOption` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `WebhookRequestDelivery` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `_JobRunToMissingConnection` table. If the table is not empty, all the data it contains will be lost.

*/

-- DropTable
DROP TABLE IF EXISTS "JobCounter";

-- DropTable
DROP TABLE IF EXISTS "WebhookDeliveryCounter";

-- DropTable
DROP TABLE IF EXISTS "ApiIntegrationVote";

-- DropTable
DROP TABLE IF EXISTS "ConnectionAttempt";

-- DropTable
DROP TABLE IF EXISTS "DeferredScheduledEventService";

-- DropTable
DROP TABLE IF EXISTS "DynamicTriggerRegistration";

-- DropTable
DROP TABLE IF EXISTS "EndpointIndex";

-- DropTable
DROP TABLE IF EXISTS "EventExample";

-- DropTable
DROP TABLE IF EXISTS "HttpSourceRequestDelivery";

-- DropTable
DROP TABLE IF EXISTS "JobAlias";

-- DropTable
DROP TABLE IF EXISTS "JobIntegration";

-- DropTable
DROP TABLE IF EXISTS "JobRunAutoYieldExecution";

-- DropTable
DROP TABLE IF EXISTS "JobRunStatusRecord";

-- DropTable
DROP TABLE IF EXISTS "JobRunSubscription";

-- DropTable
DROP TABLE IF EXISTS "KeyValueItem";

-- DropTable
DROP TABLE IF EXISTS "MissingConnection" CASCADE;

-- DropTable
DROP TABLE IF EXISTS "TaskAttempt";

-- DropTable
DROP TABLE IF EXISTS "TriggerSourceOption";

-- DropTable
DROP TABLE IF EXISTS "WebhookRequestDelivery";

-- DropTable
DROP TABLE IF EXISTS "_JobRunToMissingConnection";

-- DropEnum
DROP TYPE IF EXISTS "EndpointIndexSource";

-- DropEnum
DROP TYPE IF EXISTS "EndpointIndexStatus";

-- DropEnum
DROP TYPE IF EXISTS "JobRunSubscriptionEvents";

-- DropEnum
DROP TYPE IF EXISTS "JobRunSubscriptionRecipientMethod";

-- DropEnum
DROP TYPE IF EXISTS "JobRunSubscriptionStatus";

-- DropEnum
DROP TYPE IF EXISTS "TaskAttemptStatus";
