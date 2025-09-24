import { Attributes, Tracer } from "@opentelemetry/api";
import type {
  ExceptionEventProperties,
  SpanEvents,
  TaskEventEnvironment,
  TaskEventStyle,
  TaskRunError,
} from "@trigger.dev/core/v3";
import type {
  Prisma,
  TaskEvent,
  TaskEventKind,
  TaskEventLevel,
  TaskEventStatus,
  TaskRun,
} from "@trigger.dev/database";
import type { DetailedTraceEvent, TaskEventStoreTable } from "../taskEventStore.server";
export type { ExceptionEventProperties };

// ============================================================================
// Event Creation Types
// ============================================================================

export type CreateEventInput = Omit<
  Prisma.TaskEventCreateInput,
  | "id"
  | "createdAt"
  | "properties"
  | "metadata"
  | "style"
  | "output"
  | "payload"
  | "serviceName"
  | "serviceNamespace"
  | "tracestate"
  | "projectRef"
  | "runIsTest"
  | "workerId"
  | "queueId"
  | "queueName"
  | "batchId"
  | "taskPath"
  | "taskExportName"
  | "workerVersion"
  | "idempotencyKey"
  | "attemptId"
  | "usageDurationMs"
  | "usageCostInCents"
  | "machinePreset"
  | "machinePresetCpu"
  | "machinePresetMemory"
  | "machinePresetCentsPerMs"
  | "links"
> & {
  properties: Attributes;
  metadata: Attributes | undefined;
  style: Attributes | undefined;
};

export type CreatableEventKind = TaskEventKind;
export type CreatableEventStatus = TaskEventStatus;

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
  | "isTest"
>;

// ============================================================================
// Trace and Event Types
// ============================================================================

export type TraceAttributes = Partial<
  Pick<
    CreateEventInput,
    "isError" | "isCancelled" | "isDebug" | "runId" | "metadata" | "properties" | "style"
  >
>;

export type SetAttribute<T extends TraceAttributes> = (key: keyof T, value: T[keyof T]) => void;

export type TraceEventOptions = {
  kind?: CreatableEventKind;
  context?: Record<string, unknown>;
  spanParentAsLink?: boolean;
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
    message: true;
    style: true;
    startTime: true;
    duration: true;
    isError: true;
    isPartial: true;
    isCancelled: true;
    level: true;
    events: true;
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

export type SpanDetail = {
  // ============================================================================
  // Core Identity & Structure
  // ============================================================================
  spanId: string; // Tree structure, span identification
  parentId: string | null; // Tree hierarchy
  message: string; // Displayed as span title

  // ============================================================================
  // Status & State
  // ============================================================================
  isError: boolean; // Error status display, filtering, status icons
  isPartial: boolean; // In-progress status display, timeline calculations
  isCancelled: boolean; // Cancelled status display, status determination
  level: TaskEventLevel; // Text styling, timeline rendering decisions
  kind: TaskEventKind; // Filter "UNSPECIFIED" events, determine debug status

  // ============================================================================
  // Timing
  // ============================================================================
  startTime: Date; // Timeline calculations, display
  duration: number; // Timeline width, duration display, calculations

  // ============================================================================
  // Content & Display
  // ============================================================================
  events: SpanEvents; // Timeline events, SpanEvents component
  style: TaskEventStyle; // Icons, variants, accessories (RunIcon, SpanTitle)
  properties: Record<string, unknown> | string | number | boolean | null | undefined; // Displayed as JSON in span properties (CodeBlock)

  // ============================================================================
  // Entity & Relationships
  // ============================================================================
  entity: {
    // Used for entity type switching in SpanEntity
    type: string | undefined;
    id: string | undefined;
  };

  // ============================================================================
  // Additional Properties (Used by SpanPresenter)
  // ============================================================================
  originalRun: string | undefined; // Used by SpanPresenter for run lookup
  metadata: any; // Used by SpanPresenter for entity processing
};

// ============================================================================
// Span and Link Types
// ============================================================================

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
    level: NonNullable<CreateEventInput["level"]>;
    attemptNumber?: number;
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
    events: SpanEvents;
    startTime: Date;
    duration: number;
    isError: boolean;
    isPartial: boolean;
    isCancelled: boolean;
    level: NonNullable<CreateEventInput["level"]>;
    properties?: Attributes;
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
  // Event insertion methods
  insertMany(events: CreateEventInput[]): Promise<void>;
  insertManyImmediate(events: CreateEventInput[]): Promise<void>;

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

  // Query methods
  getTraceSummary(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceSummary | undefined>;

  getTraceDetailedSummary(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceDetailedSummary | undefined>;

  getRunEvents(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    runId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<RunPreparedEvent[]>;

  getSpan(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<SpanDetail | undefined>;

  getSpanOriginalRunId(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<string | undefined>;

  // Event recording methods
  recordEvent(
    message: string,
    options: TraceEventOptions & { duration?: number; parentId?: string }
  ): Promise<void>;

  traceEvent<TResult>(
    message: string,
    options: TraceEventOptions & { incomplete?: boolean; isError?: boolean },
    callback: (
      e: EventBuilder,
      traceContext: Record<string, string | undefined>,
      traceparent?: { traceId: string; spanId: string }
    ) => Promise<TResult>
  ): Promise<TResult>;
}
