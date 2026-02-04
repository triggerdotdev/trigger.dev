import type { BackgroundWorker, TaskRun } from "@trigger.dev/database";
import type { IOPacket, TaskRunError, TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import type { ReportUsagePlan } from "@trigger.dev/platform";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  idempotencyKeyExpiresAt?: Date;
  triggerVersion?: string;
  traceContext?: Record<string, unknown>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "replay" | "trigger";
  batchId?: string;
  batchIndex?: number;
  customIcon?: string;
  runFriendlyId?: string;
  skipChecks?: boolean;
  oneTimeUseToken?: string;
  overrideCreatedAt?: Date;
  planType?: string;
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
  validateQueueLimits(
    env: AuthenticatedEnvironment,
    itemsToAdd?: number
  ): Promise<QueueValidationResult>;
  getWorkerQueue(
    env: AuthenticatedEnvironment,
    regionOverride?: string
  ): Promise<string | undefined>;
}

export interface PayloadProcessor {
  process(request: TriggerTaskRequest): Promise<IOPacket>;
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

export type EntitlementValidationResult =
  | {
      ok: true;
      plan?: ReportUsagePlan;
    }
  | {
      ok: false;
      error: Error;
    };

export interface TriggerTaskValidator {
  validateTags(params: TagValidationParams): ValidationResult;
  validateEntitlement(params: EntitlementValidationParams): Promise<EntitlementValidationResult>;
  validateMaxAttempts(params: MaxAttemptsValidationParams): ValidationResult;
  validateParentRun(params: ParentRunValidationParams): ValidationResult;
}

export type TracedEventSpan = {
  traceId: string;
  spanId: string;
  traceContext: Record<string, unknown>;
  traceparent?: {
    traceId: string;
    spanId: string;
  };
  setAttribute: (key: string, value: string) => void;
  failWithError: (error: TaskRunError) => void;
  /**
   * Stop the span without writing any event.
   * Used when a debounced run is returned - the span for the debounced
   * trigger is created separately via traceDebouncedRun.
   */
  stop: () => void;
};

export interface TraceEventConcern {
  traceRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T>;
  traceIdempotentRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
      existingRun: TaskRun;
      idempotencyKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T>;
  traceDebouncedRun<T>(
    request: TriggerTaskRequest,
    parentStore: string | undefined,
    options: {
      existingRun: TaskRun;
      debounceKey: string;
      incomplete: boolean;
      isError: boolean;
    },
    callback: (span: TracedEventSpan, store: string) => Promise<T>
  ): Promise<T>;
}

export type TriggerRacepoints = "idempotencyKey";

export interface TriggerRacepointSystem {
  waitForRacepoint(options: { racepoint: TriggerRacepoints; id: string }): Promise<void>;
}
