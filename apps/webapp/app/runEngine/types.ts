import { BackgroundWorker, TaskRun, WorkerDeployment } from "@trigger.dev/database";

import { RunDuplicateIdempotencyKeyError, RunEngine } from "@internal/run-engine";
import { TriggerOptions } from "@trigger.dev/core/v3";
import {
  IOPacket,
  packetRequiresOffloading,
  SemanticInternalAttributes,
  TaskRunError,
  taskRunErrorEnhancer,
  taskRunErrorToString,
  TriggerTaskRequestBody,
} from "@trigger.dev/core/v3";
import {
  BatchId,
  RunId,
  sanitizeQueueName,
  stringifyDuration,
} from "@trigger.dev/core/v3/isomorphic";
import { Prisma } from "@trigger.dev/database";
import { env } from "~/env.server";
import { createTags, MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { autoIncrementCounter } from "~/services/autoIncrementCounter.server";
import { logger } from "~/services/logger.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { parseDelay } from "~/utils/delays";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { handleMetadataPacket } from "~/utils/packets";
import { eventRepository } from "../v3/eventRepository.server";
import { findCurrentWorkerFromEnvironment } from "../v3/models/workerDeployment.server";
import { uploadPacketToObjectStore } from "../v3/r2.server";
import { getTaskEventStore } from "../v3/taskEventStore.server";
import { isFinalRunStatus } from "../v3/taskStatus";
import { startActiveSpan } from "../v3/tracer.server";
import { clampMaxDuration } from "../v3/utils/maxDuration";
import { ServiceValidationError, WithRunEngine } from "../v3/services/baseService.server";
import {
  MAX_ATTEMPTS,
  OutOfEntitlementError,
  TriggerTaskServiceResult,
} from "../v3/services/triggerTask.server";
import { WorkerGroupService } from "../v3/services/worker/workerGroupService.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "replay" | "trigger";
  batchId?: string;
  batchIndex?: number;
  customIcon?: string;
  runFriendlyId?: string;
  skipChecks?: boolean;
  oneTimeUseToken?: string;
};

// domain/triggerTask.ts
export type TriggerTaskRequest = {
  taskId: string;
  environment: AuthenticatedEnvironment;
  body: TriggerTaskRequestBody;
  options?: TriggerTaskServiceOptions;
};

export type TriggerTaskResult = {
  run: TaskRun;
  isCached: boolean;
  error?: TaskRunError;
};

export type QueueValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      maximumSize: number;
      queueSize: number;
    };

export type QueueProperties = {
  queueName: string;
  lockedQueueId?: string;
};

export type LockedBackgroundWorker = Pick<
  BackgroundWorker,
  "id" | "version" | "sdkVersion" | "cliVersion"
>;

// Core domain interfaces
export interface QueueManager {
  resolveQueueProperties(
    request: TriggerTaskRequest,
    lockedBackgroundWorker?: LockedBackgroundWorker
  ): Promise<QueueProperties>;
  getQueueName(request: TriggerTaskRequest): Promise<string>;
  validateQueueLimits(env: AuthenticatedEnvironment): Promise<QueueValidationResult>;
  getMasterQueue(env: AuthenticatedEnvironment): Promise<string | undefined>;
}

export interface PayloadProcessor {
  process(payload: any, type: string, pathPrefix: string): Promise<IOPacket>;
}

// Domain validation
export class TriggerTaskValidator {
  // Pure validation functions here
}
