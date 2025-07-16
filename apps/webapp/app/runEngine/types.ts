import { BackgroundWorker, TaskRun } from "@trigger.dev/database";

import {
  IOPacket,
  RunChainState,
  TaskRunError,
  TriggerTaskRequestBody,
} from "@trigger.dev/core/v3";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";

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
  overrideCreatedAt?: Date;
};

// domain/triggerTask.ts
export type TriggerTaskRequest = {
  taskId: string;
  friendlyId: string;
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
  getWorkerQueue(env: AuthenticatedEnvironment): Promise<string | undefined>;
}

export interface PayloadProcessor {
  process(request: TriggerTaskRequest): Promise<IOPacket>;
}

export interface RunNumberIncrementer {
  incrementRunNumber<T>(
    request: TriggerTaskRequest,
    callback: (num: number) => Promise<T>
  ): Promise<T | undefined>;
}

export interface TagValidationParams {
  tags?: string[] | string;
}

export interface EntitlementValidationParams {
  environment: AuthenticatedEnvironment;
}

export interface MaxAttemptsValidationParams {
  taskId: string;
  attempt: number;
}

export interface ParentRunValidationParams {
  taskId: string;
  parentRun?: TaskRun;
  resumeParentOnCompletion?: boolean;
}

export type ValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: Error;
    };

export interface TriggerTaskValidator {
  validateTags(params: TagValidationParams): ValidationResult;
  validateEntitlement(params: EntitlementValidationParams): Promise<ValidationResult>;
  validateMaxAttempts(params: MaxAttemptsValidationParams): ValidationResult;
  validateParentRun(params: ParentRunValidationParams): ValidationResult;
}

export type TracedEventSpan = {
  traceId: string;
  spanId: string;
  traceContext: Record<string, string | undefined>;
  traceparent?: {
    traceId: string;
    spanId: string;
  };
  setAttribute: (key: string, value: string) => void;
  failWithError: (error: TaskRunError) => void;
};

export interface TraceEventConcern {
  traceRun<T>(
    request: TriggerTaskRequest,
    callback: (span: TracedEventSpan) => Promise<T>
  ): Promise<T>;
  traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan) => Promise<T>
  ): Promise<T>;
}
