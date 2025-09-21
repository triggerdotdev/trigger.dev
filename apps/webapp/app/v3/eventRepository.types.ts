import { EventEmitter } from "node:stream";
import { Attributes, AttributeValue, Link, Tracer } from "@opentelemetry/api";
import type {
  TaskRunError,
  ExceptionEventProperties,
  SpanEvents,
  TaskEventStyle,
  TaskEventEnvironment,
  SpanEvent,
} from "@trigger.dev/core/v3";
import type {
  Prisma,
  TaskEvent,
  TaskEventKind,
  TaskEventStatus,
  TaskRun,
} from "@trigger.dev/database";
import type { RedisWithClusterOptions } from "~/redis.server";
import type { DynamicFlushScheduler } from "./dynamicFlushScheduler.server";
import type { DetailedTraceEvent, TaskEventStoreTable } from "./taskEventStore.server";

// ============================================================================
// Event Creation Types
// ============================================================================

export type CreatableEvent = Omit<
  Prisma.TaskEventCreateInput,
  "id" | "createdAt" | "properties" | "metadata" | "style" | "output" | "payload"
> & {
  properties: Attributes;
  metadata: Attributes | undefined;
  style: Attributes | undefined;
  output: Attributes | string | boolean | number | undefined;
  payload: Attributes | string | boolean | number | undefined;
};

export type CreatableEventKind = TaskEventKind;
export type CreatableEventStatus = TaskEventStatus;
export type CreatableEventEnvironmentType = CreatableEvent["environmentType"];

// ============================================================================
// Task Run Types
// ============================================================================

export type CompleteableTaskRun = Pick<
  TaskRun,
  | "friendlyId"
  | "traceId"
  | "spanId"
  | "parentSpanId"
  | "createdAt"
  | "completedAt"
  | "taskIdentifier"
  | "projectId"
  | "runtimeEnvironmentId"
  | "organizationId"
  | "environmentType"
  | "isTest"
>;

// ============================================================================
// Trace and Event Types
// ============================================================================

export type TraceAttributes = Partial<
  Pick<
    CreatableEvent,
    | "attemptId"
    | "isError"
    | "isCancelled"
    | "isDebug"
    | "runId"
    | "runIsTest"
    | "output"
    | "outputType"
    | "metadata"
    | "properties"
    | "style"
    | "queueId"
    | "queueName"
    | "batchId"
    | "payload"
    | "payloadType"
    | "idempotencyKey"
  >
>;

export type SetAttribute<T extends TraceAttributes> = (key: keyof T, value: T[keyof T]) => void;

export type TraceEventOptions = {
  kind?: CreatableEventKind;
  context?: Record<string, unknown>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "trigger" | "replay";
  spanIdSeed?: string;
  attributes: TraceAttributes;
  environment: TaskEventEnvironment;
  taskSlug: string;
  startTime?: bigint;
  endTime?: Date;
  immediate?: boolean;
};

export type EventBuilder = {
  traceId: string;
  spanId: string;
  setAttribute: SetAttribute<TraceAttributes>;
  stop: () => void;
  failWithError: (error: TaskRunError) => void;
};

export type UpdateEventOptions = {
  attributes: TraceAttributes;
  endTime?: Date;
  immediate?: boolean;
  events?: SpanEvents;
};

// ============================================================================
// Configuration Types
// ============================================================================

export type EventRepoConfig = {
  batchSize: number;
  batchInterval: number;
  redis: RedisWithClusterOptions;
  retentionInDays: number;
  partitioningEnabled: boolean;
  tracer?: Tracer;
  minConcurrency?: number;
  maxConcurrency?: number;
  maxBatchSize?: number;
  memoryPressureThreshold?: number;
  loadSheddingThreshold?: number;
  loadSheddingEnabled?: boolean;
};

// ============================================================================
// Query Types
// ============================================================================

export type QueryOptions = Prisma.TaskEventWhereInput;

export type TaskEventRecord = TaskEvent;

export type QueriedEvent = Prisma.TaskEventGetPayload<{
  select: {
    spanId: true;
    parentId: true;
    runId: true;
    idempotencyKey: true;
    message: true;
    style: true;
    startTime: true;
    duration: true;
    isError: true;
    isPartial: true;
    isCancelled: true;
    level: true;
    events: true;
    environmentType: true;
    kind: true;
    attemptNumber: true;
  };
}>;

export type PreparedEvent = Omit<QueriedEvent, "events" | "style" | "duration"> & {
  duration: number;
  events: SpanEvents;
  style: TaskEventStyle;
};

export type PreparedDetailedEvent = Omit<DetailedTraceEvent, "events" | "style" | "duration"> & {
  duration: number;
  events: SpanEvents;
  style: TaskEventStyle;
};

export type RunPreparedEvent = PreparedEvent & {
  taskSlug?: string;
};

// ============================================================================
// Span and Link Types
// ============================================================================

export type SpanLink =
  | {
      type: "run";
      icon?: string;
      title: string;
      runId: string;
    }
  | {
      type: "span";
      icon?: string;
      title: string;
      traceId: string;
      spanId: string;
    };

export type SpanSummary = {
  id: string;
  parentId: string | undefined;
  runId: string;
  data: {
    message: string;
    style: TaskEventStyle;
    events: SpanEvents;
    startTime: Date;
    duration: number;
    isError: boolean;
    isPartial: boolean;
    isCancelled: boolean;
    isDebug: boolean;
    level: NonNullable<CreatableEvent["level"]>;
    environmentType: CreatableEventEnvironmentType;
  };
};

export type TraceSummary = { rootSpan: SpanSummary; spans: Array<SpanSummary> };

export type SpanDetailedSummary = {
  id: string;
  parentId: string | undefined;
  message: string;
  data: {
    runId: string;
    taskSlug?: string;
    taskPath?: string;
    events: SpanEvents;
    startTime: Date;
    duration: number;
    isError: boolean;
    isPartial: boolean;
    isCancelled: boolean;
    level: NonNullable<CreatableEvent["level"]>;
    environmentType: CreatableEventEnvironmentType;
    workerVersion?: string;
    queueName?: string;
    machinePreset?: string;
    properties?: Attributes;
    output?: Attributes;
  };
  children: Array<SpanDetailedSummary>;
};

export type TraceDetailedSummary = {
  traceId: string;
  rootSpan: SpanDetailedSummary;
};

// ============================================================================
// Event Repository Interface
// ============================================================================

/**
 * Interface for the EventRepository class.
 * Defines the public API for managing task events, traces, and spans.
 */
export interface IEventRepository {
  // Properties
  readonly subscriberCount: number;
  readonly flushSchedulerStatus: ReturnType<DynamicFlushScheduler<CreatableEvent>["getStatus"]>;

  // Event insertion methods
  insert(event: CreatableEvent): Promise<void>;
  insertImmediate(event: CreatableEvent): Promise<void>;
  insertMany(events: CreatableEvent[]): Promise<void>;
  insertManyImmediate(events: CreatableEvent[]): Promise<CreatableEvent[]>;

  // Run event completion methods
  completeSuccessfulRunEvent(params: { run: CompleteableTaskRun; endTime?: Date }): Promise<void>;

  completeCachedRunEvent(params: {
    run: CompleteableTaskRun;
    blockedRun: CompleteableTaskRun;
    spanId: string;
    parentSpanId: string;
    spanCreatedAt: Date;
    isError: boolean;
    endTime?: Date;
  }): Promise<void>;

  completeFailedRunEvent(params: {
    run: CompleteableTaskRun;
    endTime?: Date;
    exception: { message?: string; type?: string; stacktrace?: string };
  }): Promise<void>;

  completeExpiredRunEvent(params: {
    run: CompleteableTaskRun;
    endTime?: Date;
    ttl: string;
  }): Promise<void>;

  createAttemptFailedRunEvent(params: {
    run: CompleteableTaskRun;
    endTime?: Date;
    attemptNumber: number;
    exception: { message?: string; type?: string; stacktrace?: string };
  }): Promise<void>;

  cancelRunEvent(params: {
    reason: string;
    run: CompleteableTaskRun;
    cancelledAt: Date;
  }): Promise<void>;

  crashEvent(params: {
    event: TaskEventRecord;
    crashedAt: Date;
    exception: ExceptionEventProperties;
  }): Promise<void>;

  // Query methods
  getTraceSummary(
    storeTable: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceSummary | undefined>;

  getTraceDetailedSummary(
    storeTable: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceDetailedSummary | undefined>;

  getRunEvents(
    storeTable: TaskEventStoreTable,
    runId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<RunPreparedEvent[]>;

  getSpan(
    storeTable: TaskEventStoreTable,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<any>;

  // Event recording methods
  recordEvent(
    message: string,
    options: TraceEventOptions & { duration?: number; parentId?: string }
  ): Promise<CreatableEvent>;

  traceEvent<TResult>(
    message: string,
    options: TraceEventOptions & { incomplete?: boolean; isError?: boolean },
    callback: (
      e: EventBuilder,
      traceContext: Record<string, string | undefined>,
      traceparent?: { traceId: string; spanId: string }
    ) => Promise<TResult>
  ): Promise<TResult>;

  // Subscription methods
  subscribeToTrace(traceId: string): Promise<{
    unsubscribe: () => Promise<void>;
    eventEmitter: EventEmitter;
  }>;

  // ID generation methods
  generateTraceId(): string;
  generateSpanId(): string;
}
