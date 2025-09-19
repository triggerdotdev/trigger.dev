import { Attributes, AttributeValue, Link, trace, TraceFlags, Tracer } from "@opentelemetry/api";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
  AttemptFailedSpanEvent,
  correctErrorStackTrace,
  ExceptionEventProperties,
  ExceptionSpanEvent,
  flattenAttributes,
  isExceptionSpanEvent,
  NULL_SENTINEL,
  omit,
  PRIMARY_VARIANT,
  SemanticInternalAttributes,
  SpanEvent,
  SpanEvents,
  SpanMessagingEvent,
  TaskEventEnvironment,
  TaskEventStyle,
  TaskRunError,
  unflattenAttributes,
} from "@trigger.dev/core/v3";
import { parseTraceparent, serializeTraceparent } from "@trigger.dev/core/v3/isomorphic";
import { Prisma, TaskEvent, TaskEventKind, TaskEventStatus, TaskRun } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:stream";
import { Gauge } from "prom-client";
import { $replica, prisma, PrismaClient, PrismaReplicaClient } from "~/db.server";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { createRedisClient, RedisClient, RedisWithClusterOptions } from "~/redis.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { DynamicFlushScheduler } from "./dynamicFlushScheduler.server";
import { DetailedTraceEvent, TaskEventStore, TaskEventStoreTable } from "./taskEventStore.server";
import { startActiveSpan } from "./tracer.server";
import { startSpan } from "./tracing.server";

const MAX_FLUSH_DEPTH = 5;

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

export type UpdateEventOptions = {
  attributes: TraceAttributes;
  endTime?: Date;
  immediate?: boolean;
  events?: SpanEvents;
};

export class EventRepository {
  private readonly _flushScheduler: DynamicFlushScheduler<CreatableEvent>;
  private _randomIdGenerator = new RandomIdGenerator();
  private _redisPublishClient: RedisClient;
  private _subscriberCount = 0;
  private _tracer: Tracer;
  private _lastFlushedAt: Date | undefined;
  private taskEventStore: TaskEventStore;

  get subscriberCount() {
    return this._subscriberCount;
  }

  get flushSchedulerStatus() {
    return this._flushScheduler.getStatus();
  }

  constructor(
    db: PrismaClient = prisma,
    readReplica: PrismaReplicaClient = $replica,
    private readonly _config: EventRepoConfig
  ) {
    this._flushScheduler = new DynamicFlushScheduler({
      batchSize: _config.batchSize,
      flushInterval: _config.batchInterval,
      callback: this.#flushBatch.bind(this),
      minConcurrency: _config.minConcurrency,
      maxConcurrency: _config.maxConcurrency,
      maxBatchSize: _config.maxBatchSize,
      memoryPressureThreshold: _config.memoryPressureThreshold,
      loadSheddingThreshold: _config.loadSheddingThreshold,
      loadSheddingEnabled: _config.loadSheddingEnabled,
      isDroppableEvent: (event: CreatableEvent) => {
        // Only drop LOG events during load shedding
        return event.kind === TaskEventKind.LOG;
      },
    });

    this._redisPublishClient = createRedisClient("trigger:eventRepoPublisher", this._config.redis);
    this._tracer = _config.tracer ?? trace.getTracer("eventRepo", "0.0.1");

    // Instantiate the store using the partitioning flag.
    this.taskEventStore = new TaskEventStore(db, readReplica);
  }

  async insert(event: CreatableEvent) {
    this._flushScheduler.addToBatch([event]);
  }

  async insertImmediate(event: CreatableEvent) {
    await this.#flushBatch(nanoid(), [event]);
  }

  async insertMany(events: CreatableEvent[]) {
    this._flushScheduler.addToBatch(events);
  }

  async insertManyImmediate(events: CreatableEvent[]) {
    return await this.#flushBatch(nanoid(), events);
  }

  async completeSuccessfulRunEvent({ run, endTime }: { run: CompleteableTaskRun; endTime?: Date }) {
    const startTime = convertDateToNanoseconds(run.createdAt);

    await this.insertImmediate({
      message: run.taskIdentifier,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      taskSlug: run.taskIdentifier,
      projectRef: "",
      projectId: run.projectId,
      environmentId: run.runtimeEnvironmentId,
      environmentType: run.environmentType ?? "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: false,
      isCancelled: false,
      status: "OK",
      runIsTest: run.isTest,
      startTime,
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()),
      output: undefined,
      payload: undefined,
      payloadType: undefined,
    });
  }

  async completeCachedRunEvent({
    run,
    blockedRun,
    endTime,
    spanId,
    parentSpanId,
    spanCreatedAt,
    isError,
  }: {
    run: CompleteableTaskRun;
    blockedRun: CompleteableTaskRun;
    spanId: string;
    parentSpanId: string;
    spanCreatedAt: Date;
    isError: boolean;
    endTime?: Date;
  }) {
    const startTime = convertDateToNanoseconds(spanCreatedAt);

    await this.insertImmediate({
      message: run.taskIdentifier,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: "SERVER",
      traceId: blockedRun.traceId,
      spanId: spanId,
      parentId: parentSpanId,
      runId: blockedRun.friendlyId,
      taskSlug: run.taskIdentifier,
      projectRef: "",
      projectId: run.projectId,
      environmentId: run.runtimeEnvironmentId,
      environmentType: run.environmentType ?? "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError,
      isCancelled: false,
      status: "OK",
      runIsTest: run.isTest,
      startTime,
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()),
      output: undefined,
      payload: undefined,
      payloadType: undefined,
    });
  }

  async completeFailedRunEvent({
    run,
    endTime,
    exception,
  }: {
    run: CompleteableTaskRun;
    endTime?: Date;
    exception: { message?: string; type?: string; stacktrace?: string };
  }) {
    const startTime = convertDateToNanoseconds(run.createdAt);

    await this.insertImmediate({
      message: run.taskIdentifier,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      taskSlug: run.taskIdentifier,
      projectRef: "",
      projectId: run.projectId,
      environmentId: run.runtimeEnvironmentId,
      environmentType: run.environmentType ?? "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: true,
      isCancelled: false,
      status: "ERROR",
      runIsTest: run.isTest,
      startTime,
      events: [
        {
          name: "exception",
          time: endTime ?? new Date(),
          properties: {
            exception,
          },
        },
      ],
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()),
      output: undefined,
      payload: undefined,
      payloadType: undefined,
    });
  }

  async completeExpiredRunEvent({
    run,
    endTime,
    ttl,
  }: {
    run: CompleteableTaskRun;
    endTime?: Date;
    ttl: string;
  }) {
    const startTime = convertDateToNanoseconds(run.createdAt);

    await this.insertImmediate({
      message: run.taskIdentifier,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      taskSlug: run.taskIdentifier,
      projectRef: "",
      projectId: run.projectId,
      environmentId: run.runtimeEnvironmentId,
      environmentType: run.environmentType ?? "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: true,
      isCancelled: false,
      status: "ERROR",
      runIsTest: run.isTest,
      startTime,
      events: [
        {
          name: "exception",
          time: endTime ?? new Date(),
          properties: {
            exception: {
              message: `Run expired because the TTL (${ttl}) was reached`,
            },
          },
        },
      ],
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()),
      output: undefined,
      payload: undefined,
      payloadType: undefined,
    });
  }

  async createAttemptFailedRunEvent({
    run,
    endTime,
    attemptNumber,
    exception,
  }: {
    run: CompleteableTaskRun;
    endTime?: Date;
    attemptNumber: number;
    exception: { message?: string; type?: string; stacktrace?: string };
  }) {
    const startTime = convertDateToNanoseconds(run.createdAt);

    await this.insertImmediate({
      message: run.taskIdentifier,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: "UNSPECIFIED", // This will be treated as an "invisible" event
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      taskSlug: run.taskIdentifier,
      projectRef: "",
      projectId: run.projectId,
      environmentId: run.runtimeEnvironmentId,
      environmentType: run.environmentType ?? "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: true,
      isError: false,
      isCancelled: false,
      status: "OK",
      runIsTest: run.isTest,
      startTime,
      events: [
        {
          name: "attempt_failed",
          time: endTime ?? new Date(),
          properties: {
            exception,
            attemptNumber,
            runId: run.friendlyId,
          },
        } satisfies AttemptFailedSpanEvent,
      ],
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()),
      output: undefined,
      payload: undefined,
      payloadType: undefined,
    });
  }

  async cancelRunEvent({
    reason,
    run,
    cancelledAt,
  }: {
    reason: string;
    run: CompleteableTaskRun;
    cancelledAt: Date;
  }) {
    const startTime = convertDateToNanoseconds(run.createdAt);

    await this.insertImmediate({
      message: run.taskIdentifier,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      taskSlug: run.taskIdentifier,
      projectRef: "",
      projectId: run.projectId,
      environmentId: run.runtimeEnvironmentId,
      environmentType: run.environmentType ?? "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: true,
      isCancelled: true,
      status: "ERROR",
      runIsTest: run.isTest,
      events: [
        {
          name: "cancellation",
          time: cancelledAt,
          properties: {
            reason,
          },
        },
      ],
      startTime,
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, cancelledAt),
      output: undefined,
      payload: undefined,
      payloadType: undefined,
    });
  }

  async crashEvent({
    event,
    crashedAt,
    exception,
  }: {
    event: TaskEventRecord;
    crashedAt: Date;
    exception: ExceptionEventProperties;
  }) {
    if (!event.isPartial) {
      return;
    }

    await this.insertImmediate({
      ...omit(event, "id"),
      isPartial: false,
      isError: true,
      isCancelled: false,
      status: "ERROR",
      links: event.links ?? [],
      events: [
        {
          name: "exception",
          time: crashedAt,
          properties: {
            exception,
          },
        } satisfies ExceptionSpanEvent,
        ...((event.events as any[]) ?? []),
      ],
      duration: calculateDurationFromStart(event.startTime, crashedAt),
      properties: event.properties as Attributes,
      metadata: event.metadata as Attributes,
      style: event.style as Attributes,
      output: event.output as Attributes,
      outputType: event.outputType,
      payload: event.payload as Attributes,
      payloadType: event.payloadType,
    });
  }

  public async getTraceSummary(
    storeTable: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceSummary | undefined> {
    return await startActiveSpan("getTraceSummary", async (span) => {
      const events = await this.taskEventStore.findTraceEvents(
        storeTable,
        traceId,
        startCreatedAt,
        endCreatedAt,
        { includeDebugLogs: options?.includeDebugLogs }
      );

      let preparedEvents: Array<PreparedEvent> = [];
      let rootSpanId: string | undefined;
      const eventsBySpanId = new Map<string, PreparedEvent>();

      for (const event of events) {
        preparedEvents.push(prepareEvent(event));

        if (!rootSpanId && !event.parentId) {
          rootSpanId = event.spanId;
        }
      }

      for (const event of preparedEvents) {
        const existingEvent = eventsBySpanId.get(event.spanId);

        if (!existingEvent) {
          eventsBySpanId.set(event.spanId, event);
          continue;
        }

        // This is an invisible event, and we just want to keep the original event but concat together
        // the event.events with the existingEvent.events
        if (event.kind === "UNSPECIFIED") {
          eventsBySpanId.set(event.spanId, {
            ...existingEvent,
            events: [...(existingEvent.events ?? []), ...(event.events ?? [])],
          });
          continue;
        }

        if (event.isCancelled || !event.isPartial) {
          const mergedEvent: PreparedEvent = {
            ...event,
            // Preserve style from the original partial event
            style: existingEvent.style,
            events: [...(existingEvent.events ?? []), ...(event.events ?? [])],
          };
          eventsBySpanId.set(event.spanId, mergedEvent);
          continue;
        }
      }

      preparedEvents = Array.from(eventsBySpanId.values());

      const spansBySpanId = new Map<string, SpanSummary>();

      const spans = preparedEvents.map((event) => {
        const overrides = getAncestorOverrides({
          spansById: eventsBySpanId,
          span: event,
        });

        const ancestorCancelled = overrides?.isCancelled ?? false;
        const ancestorIsError = overrides?.isError ?? false;
        const duration = overrides?.duration ?? event.duration;
        const events = [...(overrides?.events ?? []), ...(event.events ?? [])];
        const isPartial = ancestorCancelled || ancestorIsError ? false : event.isPartial;
        const isCancelled =
          event.isCancelled === true ? true : event.isPartial && ancestorCancelled;
        const isError = isCancelled
          ? false
          : typeof overrides?.isError === "boolean"
          ? overrides.isError
          : event.isError;

        const span = {
          id: event.spanId,
          parentId: event.parentId ?? undefined,
          runId: event.runId,
          idempotencyKey: event.idempotencyKey,
          data: {
            message: event.message,
            style: event.style,
            duration,
            isError,
            isPartial,
            isCancelled,
            isDebug: event.kind === TaskEventKind.LOG,
            startTime: getDateFromNanoseconds(event.startTime),
            level: event.level,
            events,
            environmentType: event.environmentType,
          },
        };

        spansBySpanId.set(event.spanId, span);

        return span;
      });

      if (!rootSpanId) {
        return;
      }

      const rootSpan = spansBySpanId.get(rootSpanId);

      if (!rootSpan) {
        return;
      }

      return {
        rootSpan,
        spans,
      };
    });
  }

  public async getTraceDetailedSummary(
    storeTable: TaskEventStoreTable,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceDetailedSummary | undefined> {
    return await startActiveSpan("getTraceDetailedSummary", async (span) => {
      const events = await this.taskEventStore.findDetailedTraceEvents(
        storeTable,
        traceId,
        startCreatedAt,
        endCreatedAt,
        { includeDebugLogs: options?.includeDebugLogs }
      );

      let preparedEvents: Array<PreparedDetailedEvent> = [];
      let rootSpanId: string | undefined;
      const eventsBySpanId = new Map<string, PreparedDetailedEvent>();

      for (const event of events) {
        preparedEvents.push(prepareDetailedEvent(event));

        if (!rootSpanId && !event.parentId) {
          rootSpanId = event.spanId;
        }
      }

      for (const event of preparedEvents) {
        const existingEvent = eventsBySpanId.get(event.spanId);

        if (!existingEvent) {
          eventsBySpanId.set(event.spanId, event);
          continue;
        }

        // This is an invisible event, and we just want to keep the original event but concat together
        // the event.events with the existingEvent.events
        if (event.kind === "UNSPECIFIED") {
          eventsBySpanId.set(event.spanId, {
            ...existingEvent,
            events: [...(existingEvent.events ?? []), ...(event.events ?? [])],
          });
          continue;
        }

        if (event.isCancelled || !event.isPartial) {
          // If we have a cancelled event and an existing partial event,
          // merge them: use cancelled event data but preserve style from the partial event
          if (event.isCancelled && existingEvent.isPartial && !existingEvent.isCancelled) {
            const mergedEvent: PreparedDetailedEvent = {
              ...event, // Use cancelled event as base (has correct timing, status, events)
              // Preserve style from the original partial event
              style: existingEvent.style,
              events: [...(existingEvent.events ?? []), ...(event.events ?? [])],
            };
            eventsBySpanId.set(event.spanId, mergedEvent);
            continue;
          }
        }
      }

      preparedEvents = Array.from(eventsBySpanId.values());

      if (!rootSpanId) {
        return;
      }

      // Build hierarchical structure
      const spanDetailedSummaryMap = new Map<string, SpanDetailedSummary>();

      // First pass: create all span detailed summaries
      for (const event of preparedEvents) {
        const overrides = getAncestorOverrides({
          spansById: eventsBySpanId,
          span: event,
        });

        const ancestorCancelled = overrides?.isCancelled ?? false;
        const ancestorIsError = overrides?.isError ?? false;
        const duration = overrides?.duration ?? event.duration;
        const events = [...(overrides?.events ?? []), ...(event.events ?? [])];
        const isPartial = ancestorCancelled || ancestorIsError ? false : event.isPartial;
        const isCancelled =
          event.isCancelled === true ? true : event.isPartial && ancestorCancelled;
        const isError = isCancelled
          ? false
          : typeof overrides?.isError === "boolean"
          ? overrides.isError
          : event.isError;

        const output = event.output ? (event.output as Attributes) : undefined;
        const properties = event.properties
          ? removePrivateProperties(event.properties as Attributes)
          : {};

        const spanDetailedSummary: SpanDetailedSummary = {
          id: event.spanId,
          parentId: event.parentId ?? undefined,
          message: event.message,
          data: {
            runId: event.runId,
            taskSlug: event.taskSlug ?? undefined,
            taskPath: event.taskPath ?? undefined,
            events: events?.filter((e) => !e.name.startsWith("trigger.dev")),
            startTime: getDateFromNanoseconds(event.startTime),
            duration: nanosecondsToMilliseconds(duration),
            isError,
            isPartial,
            isCancelled,
            level: event.level,
            environmentType: event.environmentType,
            workerVersion: event.workerVersion ?? undefined,
            queueName: event.queueName ?? undefined,
            machinePreset: event.machinePreset ?? undefined,
            properties,
            output,
          },
          children: [],
        };

        spanDetailedSummaryMap.set(event.spanId, spanDetailedSummary);
      }

      // Second pass: build parent-child relationships
      for (const spanSummary of spanDetailedSummaryMap.values()) {
        if (spanSummary.parentId) {
          const parent = spanDetailedSummaryMap.get(spanSummary.parentId);
          if (parent) {
            parent.children.push(spanSummary);
          }
        }
      }

      const rootSpan = spanDetailedSummaryMap.get(rootSpanId);

      if (!rootSpan) {
        return;
      }

      return {
        traceId,
        rootSpan,
      };
    });
  }

  public async getRunEvents(
    storeTable: TaskEventStoreTable,
    runId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<RunPreparedEvent[]> {
    return await startActiveSpan("getRunEvents", async (span) => {
      const events = await this.taskEventStore.findMany(
        storeTable,
        {
          runId,
          isPartial: false,
        },
        startCreatedAt,
        endCreatedAt,
        {
          spanId: true,
          parentId: true,
          runId: true,
          idempotencyKey: true,
          message: true,
          style: true,
          startTime: true,
          duration: true,
          isError: true,
          isPartial: true,
          isCancelled: true,
          kind: true,
          level: true,
          events: true,
          environmentType: true,
          taskSlug: true,
          attemptNumber: true,
        }
      );

      let preparedEvents: Array<PreparedEvent> = [];

      for (const event of events) {
        if (event.kind === "UNSPECIFIED") {
          continue;
        }

        preparedEvents.push(prepareEvent(event));
      }

      return preparedEvents;
    });
  }

  // A Span can be cancelled if it is partial and has a parent that is cancelled
  // And a span's duration, if it is partial and has a cancelled parent, is the time between the start of the span and the time of the cancellation event of the parent
  public async getSpan(
    storeTable: TaskEventStoreTable,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ) {
    return await startActiveSpan("getSpan", async (s) => {
      const spanEvent = await this.#getSpanEvent(
        storeTable,
        spanId,
        startCreatedAt,
        endCreatedAt,
        options
      );

      if (!spanEvent) {
        return;
      }

      const preparedEvent = prepareEvent(spanEvent);

      const span = await this.#createSpanFromEvent(
        storeTable,
        preparedEvent,
        startCreatedAt,
        endCreatedAt
      );

      const output = rehydrateJson(spanEvent.output);
      const payload = rehydrateJson(spanEvent.payload);

      const show = rehydrateShow(spanEvent.properties);

      const properties = sanitizedAttributes(spanEvent.properties);

      const messagingEvent = SpanMessagingEvent.optional().safeParse(
        (properties as any)?.messaging
      );

      const links: SpanLink[] = [];

      if (messagingEvent.success && messagingEvent.data) {
        if (messagingEvent.data.message && "id" in messagingEvent.data.message) {
          if (messagingEvent.data.message.id.startsWith("run_")) {
            links.push({
              type: "run",
              icon: "runs",
              title: `Run ${messagingEvent.data.message.id}`,
              runId: messagingEvent.data.message.id,
            });
          }
        }
      }

      const backLinks = spanEvent.links as any as Link[] | undefined;

      if (backLinks && backLinks.length > 0) {
        backLinks.forEach((l) => {
          const title = String(
            l.attributes?.[SemanticInternalAttributes.LINK_TITLE] ?? "Triggered by"
          );

          links.push({
            type: "span",
            icon: "trigger",
            title,
            traceId: l.context.traceId,
            spanId: l.context.spanId,
          });
        });
      }

      const spanEvents = transformEvents(
        span.data.events,
        spanEvent.metadata as Attributes,
        spanEvent.environmentType === "DEVELOPMENT"
      );

      const originalRun = rehydrateAttribute<string>(
        spanEvent.properties,
        SemanticInternalAttributes.ORIGINAL_RUN_ID
      );

      const entity = {
        type: rehydrateAttribute<string>(
          spanEvent.properties,
          SemanticInternalAttributes.ENTITY_TYPE
        ),
        id: rehydrateAttribute<string>(spanEvent.properties, SemanticInternalAttributes.ENTITY_ID),
      };

      return {
        ...spanEvent,
        ...span.data,
        payload,
        output,
        properties,
        events: spanEvents,
        show,
        links,
        originalRun,
        entity,
      };
    });
  }

  async #createSpanFromEvent(
    storeTable: TaskEventStoreTable,
    event: PreparedEvent,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ) {
    return await startActiveSpan("createSpanFromEvent", async (s) => {
      let overrides: AncestorOverrides | undefined;

      if (!event.isCancelled && event.isPartial) {
        await this.#walkSpanAncestors(
          storeTable,
          event,
          startCreatedAt,
          endCreatedAt,
          (ancestorEvent, level) => {
            if (level >= 8) {
              return { stop: true };
            }

            if (ancestorEvent.isCancelled) {
              overrides = {
                isCancelled: true,
              };

              // We need to get the cancellation time from the cancellation span event
              const cancellationEvent = ancestorEvent.events.find(
                (event) => event.name === "cancellation"
              );

              if (cancellationEvent) {
                overrides.duration = calculateDurationFromStart(
                  event.startTime,
                  cancellationEvent.time
                );
              }

              return { stop: true };
            }

            const attemptFailedEvent = (ancestorEvent.events ?? []).find(
              (spanEvent) =>
                spanEvent.name === "attempt_failed" &&
                spanEvent.properties.attemptNumber === event.attemptNumber
            );

            if (!attemptFailedEvent) {
              return { stop: false };
            }

            overrides = {
              isError: true,
              events: [
                {
                  name: "exception",
                  time: attemptFailedEvent.time,
                  properties: {
                    exception: (attemptFailedEvent as AttemptFailedSpanEvent).properties.exception,
                  },
                },
              ],
              duration: calculateDurationFromStart(event.startTime, attemptFailedEvent.time),
            };

            return { stop: false };
          }
        );
      }

      const ancestorCancelled = overrides?.isCancelled ?? false;
      const ancestorIsError = overrides?.isError ?? false;
      const duration = overrides?.duration ?? event.duration;
      const events = [...(overrides?.events ?? []), ...(event.events ?? [])];
      const isPartial = ancestorCancelled || ancestorIsError ? false : event.isPartial;
      const isCancelled = event.isCancelled === true ? true : event.isPartial && ancestorCancelled;
      const isError = isCancelled
        ? false
        : typeof overrides?.isError === "boolean"
        ? overrides.isError
        : event.isError;

      const span = {
        id: event.spanId,
        parentId: event.parentId ?? undefined,
        runId: event.runId,
        idempotencyKey: event.idempotencyKey,
        data: {
          message: event.message,
          style: event.style,
          duration,
          isError,
          isPartial,
          isCancelled,
          startTime: getDateFromNanoseconds(event.startTime),
          level: event.level,
          events,
          environmentType: event.environmentType,
        },
      };

      return span;
    });
  }

  async #walkSpanAncestors(
    storeTable: TaskEventStoreTable,
    event: PreparedEvent,
    startCreatedAt: Date,
    endCreatedAt: Date | undefined,
    callback: (event: PreparedEvent, level: number) => { stop: boolean }
  ) {
    const parentId = event.parentId;
    if (!parentId) {
      return;
    }

    await startActiveSpan("walkSpanAncestors", async (s) => {
      let parentEvent = await this.#getSpanEvent(
        storeTable,
        parentId,
        startCreatedAt,
        endCreatedAt
      );
      let level = 1;

      while (parentEvent) {
        const preparedParentEvent = prepareEvent(parentEvent);

        const result = callback(preparedParentEvent, level);

        if (result.stop) {
          return;
        }

        if (!preparedParentEvent.parentId) {
          return;
        }

        parentEvent = await this.#getSpanEvent(
          storeTable,
          preparedParentEvent.parentId,
          startCreatedAt,
          endCreatedAt
        );

        level++;
      }
    });
  }

  async #getSpanEvent(
    storeTable: TaskEventStoreTable,
    spanId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ) {
    return await startActiveSpan("getSpanEvent", async (s) => {
      const events = await this.taskEventStore.findMany(
        storeTable,
        { spanId },
        startCreatedAt,
        endCreatedAt,
        undefined,
        {
          startTime: "asc",
        },
        options
      );

      let finalEvent: TaskEvent | undefined;
      let overrideEvents: TaskEvent[] = [];
      let partialEvent: TaskEvent | undefined;

      // Separate partial and final events
      for (const event of events) {
        if (event.kind === "UNSPECIFIED") {
          overrideEvents.push(event);
          continue;
        }

        if (event.isPartial) {
          // Take the first partial event (earliest)
          if (!partialEvent) {
            partialEvent = event;
          }
        } else {
          // Take the last complete/cancelled event (most recent)
          finalEvent = event;
        }
      }

      // If we have both partial and final events, merge them intelligently
      if (finalEvent && partialEvent) {
        return this.#mergeOverrides(
          this.#mergePartialWithFinalEvent(partialEvent, finalEvent),
          overrideEvents
        );
      }

      // Return whichever event we have
      return this.#mergeOverrides(finalEvent ?? partialEvent, overrideEvents);
    });
  }

  /**
   * Merges a partial event with a final (complete/cancelled) event.
   * Uses the final event as base but fills in missing fields from the partial event.
   */
  #mergePartialWithFinalEvent(partialEvent: TaskEvent, finalEvent: TaskEvent): TaskEvent {
    const merged = {
      ...finalEvent, // Use final event as base
      // Override with partial event fields only if final event fields are missing/empty
      properties: isEmpty(finalEvent.properties) ? partialEvent.properties : finalEvent.properties,
      metadata: isEmpty(finalEvent.metadata) ? partialEvent.metadata : finalEvent.metadata,
      style: isEmpty(finalEvent.style) ? partialEvent.style : finalEvent.style,
      output: isEmpty(finalEvent.output) ? partialEvent.output : finalEvent.output,
      payload: isEmpty(finalEvent.payload) ? partialEvent.payload : finalEvent.payload,
      payloadType: !finalEvent.payloadType ? partialEvent.payloadType : finalEvent.payloadType,
    };

    return merged;
  }

  #mergeOverrides(
    event: TaskEvent | undefined,
    overrideEvents: TaskEvent[]
  ): TaskEvent | undefined {
    function extractEventsFromEvent(event: TaskEvent): SpanEvent[] {
      return (event.events ?? []) as unknown as SpanEvent[];
    }

    if (!event) {
      return;
    }

    return {
      ...event,
      events: [
        ...extractEventsFromEvent(event),
        ...overrideEvents.flatMap(extractEventsFromEvent),
      ] as unknown as Prisma.JsonValue,
    };
  }

  public async recordEvent(
    message: string,
    options: TraceEventOptions & { duration?: number; parentId?: string }
  ) {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const startTime = options.startTime ?? getNowInNanoseconds();
    const duration =
      options.duration ??
      (options.endTime ? calculateDurationFromStart(startTime, options.endTime) : 100);

    const traceId = propagatedContext?.traceparent?.traceId ?? this.generateTraceId();
    const parentId = options.parentId ?? propagatedContext?.traceparent?.spanId;
    const tracestate = propagatedContext?.tracestate;
    const spanId = options.spanIdSeed
      ? this.#generateDeterministicSpanId(traceId, options.spanIdSeed)
      : this.generateSpanId();

    const metadata = {
      [SemanticInternalAttributes.ENVIRONMENT_ID]: options.environment.id,
      [SemanticInternalAttributes.ENVIRONMENT_TYPE]: options.environment.type,
      [SemanticInternalAttributes.ORGANIZATION_ID]: options.environment.organizationId,
      [SemanticInternalAttributes.PROJECT_ID]: options.environment.projectId,
      [SemanticInternalAttributes.PROJECT_REF]: options.environment.project.externalRef,
      [SemanticInternalAttributes.RUN_ID]: options.attributes.runId,
      [SemanticInternalAttributes.RUN_IS_TEST]: options.attributes.runIsTest ?? false,
      [SemanticInternalAttributes.BATCH_ID]: options.attributes.batchId ?? undefined,
      [SemanticInternalAttributes.TASK_SLUG]: options.taskSlug,
      [SemanticResourceAttributes.SERVICE_NAME]: "api server",
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: "trigger.dev",
      ...options.attributes.metadata,
    };

    const style = {
      [SemanticInternalAttributes.STYLE_ICON]: options.attributes.isDebug ? "warn" : "play",
    };

    if (!options.attributes.runId) {
      throw new Error("runId is required");
    }

    const event: CreatableEvent = {
      traceId,
      spanId,
      parentId,
      tracestate: typeof tracestate === "string" ? tracestate : undefined,
      message: message,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: options.attributes.isDebug ? "WARN" : "TRACE",
      kind: options.attributes.isDebug ? TaskEventKind.LOG : options.kind,
      status: "OK",
      startTime,
      isPartial: false,
      duration, // convert to nanoseconds
      environmentId: options.environment.id,
      environmentType: options.environment.type,
      organizationId: options.environment.organizationId,
      projectId: options.environment.projectId,
      projectRef: options.environment.project.externalRef,
      runId: options.attributes.runId,
      runIsTest: options.attributes.runIsTest ?? false,
      taskSlug: options.taskSlug,
      queueId: options.attributes.queueId,
      queueName: options.attributes.queueName,
      batchId: options.attributes.batchId ?? undefined,
      properties: {
        ...style,
        ...(flattenAttributes(metadata, SemanticInternalAttributes.METADATA) as Record<
          string,
          string
        >),
        ...options.attributes.properties,
      },
      metadata: metadata,
      style: stripAttributePrefix(style, SemanticInternalAttributes.STYLE),
      output: undefined,
      outputType: undefined,
      payload: undefined,
      payloadType: undefined,
    };

    if (options.immediate) {
      await this.insertImmediate(event);
    } else {
      this._flushScheduler.addToBatch([event]);
    }

    return event;
  }

  public async traceEvent<TResult>(
    message: string,
    options: TraceEventOptions & { incomplete?: boolean; isError?: boolean },
    callback: (
      e: EventBuilder,
      traceContext: Record<string, string | undefined>,
      traceparent?: { traceId: string; spanId: string }
    ) => Promise<TResult>
  ): Promise<TResult> {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const start = process.hrtime.bigint();
    const startTime = options.startTime ?? getNowInNanoseconds();

    const traceId = options.spanParentAsLink
      ? this.generateTraceId()
      : propagatedContext?.traceparent?.traceId ?? this.generateTraceId();
    const parentId = options.spanParentAsLink ? undefined : propagatedContext?.traceparent?.spanId;
    const tracestate = options.spanParentAsLink ? undefined : propagatedContext?.tracestate;
    const spanId = options.spanIdSeed
      ? this.#generateDeterministicSpanId(traceId, options.spanIdSeed)
      : this.generateSpanId();

    const traceContext = {
      ...options.context,
      traceparent: serializeTraceparent(traceId, spanId),
    };

    const links: Link[] =
      options.spanParentAsLink && propagatedContext?.traceparent
        ? [
            {
              context: {
                traceId: propagatedContext.traceparent.traceId,
                spanId: propagatedContext.traceparent.spanId,
                traceFlags: TraceFlags.SAMPLED,
              },
              attributes: {
                [SemanticInternalAttributes.LINK_TITLE]:
                  options.parentAsLinkType === "replay" ? "Replay of" : "Triggered by",
              },
            },
          ]
        : [];

    let isStopped = false;
    let failedWithError: TaskRunError | undefined;

    const eventBuilder = {
      traceId,
      spanId,
      setAttribute: (key: keyof TraceAttributes, value: TraceAttributes[keyof TraceAttributes]) => {
        if (value) {
          // We need to merge the attributes with the existing attributes
          const existingValue = options.attributes[key];

          if (existingValue && typeof existingValue === "object" && typeof value === "object") {
            // @ts-ignore
            options.attributes[key] = { ...existingValue, ...value };
          } else {
            // @ts-ignore
            options.attributes[key] = value;
          }
        }
      },
      stop: () => {
        isStopped = true;
      },
      failWithError: (error: TaskRunError) => {
        failedWithError = error;
      },
    };

    const result = await callback(eventBuilder, traceContext, propagatedContext?.traceparent);

    if (isStopped) {
      return result;
    }

    const duration = process.hrtime.bigint() - start;

    const metadata = {
      [SemanticInternalAttributes.ENVIRONMENT_ID]: options.environment.id,
      [SemanticInternalAttributes.ENVIRONMENT_TYPE]: options.environment.type,
      [SemanticInternalAttributes.ORGANIZATION_ID]: options.environment.organizationId,
      [SemanticInternalAttributes.PROJECT_ID]: options.environment.projectId,
      [SemanticInternalAttributes.PROJECT_REF]: options.environment.project.externalRef,
      [SemanticInternalAttributes.RUN_ID]: options.attributes.runId,
      [SemanticInternalAttributes.RUN_IS_TEST]: options.attributes.runIsTest ?? false,
      [SemanticInternalAttributes.BATCH_ID]: options.attributes.batchId ?? undefined,
      [SemanticInternalAttributes.TASK_SLUG]: options.taskSlug,
      [SemanticResourceAttributes.SERVICE_NAME]: "api server",
      [SemanticResourceAttributes.SERVICE_NAMESPACE]: "trigger.dev",
      ...options.attributes.metadata,
    };

    const style = {
      [SemanticInternalAttributes.STYLE_ICON]: "task",
      [SemanticInternalAttributes.STYLE_VARIANT]: PRIMARY_VARIANT,
      ...options.attributes.style,
    };

    if (!options.attributes.runId) {
      throw new Error("runId is required");
    }

    const event: CreatableEvent = {
      traceId,
      spanId,
      parentId,
      tracestate: typeof tracestate === "string" ? tracestate : undefined,
      duration: options.incomplete ? 0 : duration,
      isPartial: failedWithError ? false : options.incomplete,
      isError: options.isError === true || !!failedWithError,
      message: message,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: options.kind,
      status: failedWithError ? "ERROR" : "OK",
      startTime,
      environmentId: options.environment.id,
      environmentType: options.environment.type,
      organizationId: options.environment.organizationId,
      projectId: options.environment.projectId,
      projectRef: options.environment.project.externalRef,
      runId: options.attributes.runId,
      runIsTest: options.attributes.runIsTest ?? false,
      taskSlug: options.taskSlug,
      queueId: options.attributes.queueId,
      queueName: options.attributes.queueName,
      batchId: options.attributes.batchId ?? undefined,
      properties: {
        ...(flattenAttributes(metadata, SemanticInternalAttributes.METADATA) as Record<
          string,
          string
        >),
        ...flattenAttributes(options.attributes.properties),
      },
      metadata: metadata,
      style: stripAttributePrefix(style, SemanticInternalAttributes.STYLE),
      output: undefined,
      outputType: undefined,
      links: links as unknown as Prisma.InputJsonValue,
      payload: options.attributes.payload,
      payloadType: options.attributes.payloadType,
      idempotencyKey: options.attributes.idempotencyKey,
      events: failedWithError
        ? [
            {
              name: "exception",
              time: new Date(),
              properties: {
                exception: createExceptionPropertiesFromError(failedWithError),
              },
            },
          ]
        : undefined,
    };

    if (options.immediate) {
      await this.insertImmediate(event);
    } else {
      this._flushScheduler.addToBatch([event]);
    }

    return result;
  }

  async subscribeToTrace(traceId: string) {
    const redis = createRedisClient("trigger:eventRepoSubscriber", this._config.redis);

    const channel = `events:${traceId}`;

    // Subscribe to the channel.
    await redis.subscribe(channel);

    // Increment the subscriber count.
    this._subscriberCount++;

    const eventEmitter = new EventEmitter();

    // Define the message handler.
    redis.on("message", (_, message) => {
      eventEmitter.emit("message", message);
    });

    // Return a function that can be used to unsubscribe.
    const unsubscribe = async () => {
      await redis.unsubscribe(channel);
      redis.quit();
      this._subscriberCount--;
    };

    return {
      unsubscribe,
      eventEmitter,
    };
  }

  async #flushBatch(flushId: string, batch: CreatableEvent[]) {
    return await startSpan(this._tracer, "flushBatch", async (span) => {
      const events = excludePartialEventsWithCorrespondingFullEvent(batch);

      span.setAttribute("flush_id", flushId);
      span.setAttribute("event_count", events.length);
      span.setAttribute("partial_event_count", batch.length - events.length);
      span.setAttribute(
        "last_flush_in_ms",
        this._lastFlushedAt ? new Date().getTime() - this._lastFlushedAt.getTime() : 0
      );

      const flushedEvents = await this.#doFlushBatch(flushId, events);

      this._lastFlushedAt = new Date();

      if (flushedEvents.length !== events.length) {
        logger.debug("[EventRepository][flushBatch] Failed to insert all events", {
          attemptCount: events.length,
          successCount: flushedEvents.length,
        });

        span.setAttribute("failed_event_count", events.length - flushedEvents.length);
      }

      this.#publishToRedis(flushedEvents);
    });
  }

  private get taskEventStoreTable(): TaskEventStoreTable {
    return this._config.partitioningEnabled ? "taskEventPartitioned" : "taskEvent";
  }

  async #doFlushBatch(
    flushId: string,
    events: CreatableEvent[],
    depth: number = 1
  ): Promise<CreatableEvent[]> {
    return await startSpan(this._tracer, "doFlushBatch", async (span) => {
      try {
        span.setAttribute("event_count", events.length);
        span.setAttribute("depth", depth);
        span.setAttribute("flush_id", flushId);

        await this.taskEventStore.createMany(
          this.taskEventStoreTable,
          events as Prisma.TaskEventCreateManyInput[]
        );

        span.setAttribute("inserted_event_count", events.length);

        return events;
      } catch (error) {
        if (isRetriablePrismaError(error)) {
          const isKnownError = error instanceof Prisma.PrismaClientKnownRequestError;
          span.setAttribute("prisma_error_type", isKnownError ? "known" : "unknown");

          const errorDetails = getPrismaErrorDetails(error);
          if (errorDetails.code) {
            span.setAttribute("prisma_error_code", errorDetails.code);
          }

          logger.info("Failed to insert events, will attempt bisection", {
            error: errorDetails,
          });

          if (events.length === 1) {
            logger.debug("Attempting to insert event individually and it failed", {
              event: events[0],
              error: errorDetails,
            });

            span.setAttribute("failed_event_count", 1);

            return [];
          }

          if (depth > MAX_FLUSH_DEPTH) {
            logger.error("Failed to insert events, reached maximum depth", {
              error: errorDetails,
              depth,
              eventsCount: events.length,
            });

            span.setAttribute("reached_max_flush_depth", true);
            span.setAttribute("failed_event_count", events.length);

            return [];
          }

          // Split the events into two batches, and recursively try to insert them.
          const middle = Math.floor(events.length / 2);
          const [firstHalf, secondHalf] = [events.slice(0, middle), events.slice(middle)];

          return await startSpan(this._tracer, "bisectBatch", async (span) => {
            span.setAttribute("first_half_count", firstHalf.length);
            span.setAttribute("second_half_count", secondHalf.length);
            span.setAttribute("depth", depth);
            span.setAttribute("flush_id", flushId);

            const [firstHalfEvents, secondHalfEvents] = await Promise.all([
              this.#doFlushBatch(flushId, firstHalf, depth + 1),
              this.#doFlushBatch(flushId, secondHalf, depth + 1),
            ]);

            return firstHalfEvents.concat(secondHalfEvents);
          });
        }

        throw error;
      }
    });
  }

  async #publishToRedis(events: CreatableEvent[]) {
    if (events.length === 0) return;
    const uniqueTraces = new Set(events.map((e) => `events:${e.traceId}`));

    await Promise.allSettled(
      Array.from(uniqueTraces).map((traceId) =>
        this._redisPublishClient.publish(traceId, new Date().toISOString())
      )
    );
  }

  public generateTraceId() {
    return this._randomIdGenerator.generateTraceId();
  }

  public generateSpanId() {
    return this._randomIdGenerator.generateSpanId();
  }

  /**
   * Returns a deterministically random 8-byte span ID formatted/encoded as a 16 lowercase hex
   * characters corresponding to 64 bits, based on the trace ID and seed.
   */
  #generateDeterministicSpanId(traceId: string, seed: string) {
    const hash = createHash("sha1");
    hash.update(traceId);
    hash.update(seed);
    const buffer = hash.digest();
    let hexString = "";
    for (let i = 0; i < 8; i++) {
      const val = buffer.readUInt8(i);
      const str = val.toString(16).padStart(2, "0");
      hexString += str;
    }
    return hexString;
  }
}

export const eventRepository = singleton("eventRepo", initializeEventRepo);

function initializeEventRepo() {
  const repo = new EventRepository(prisma, $replica, {
    batchSize: env.EVENTS_BATCH_SIZE,
    batchInterval: env.EVENTS_BATCH_INTERVAL,
    retentionInDays: env.EVENTS_DEFAULT_LOG_RETENTION,
    partitioningEnabled: env.TASK_EVENT_PARTITIONING_ENABLED === "1",
    minConcurrency: env.EVENTS_MIN_CONCURRENCY,
    maxConcurrency: env.EVENTS_MAX_CONCURRENCY,
    maxBatchSize: env.EVENTS_MAX_BATCH_SIZE,
    memoryPressureThreshold: env.EVENTS_MEMORY_PRESSURE_THRESHOLD,
    loadSheddingThreshold: env.EVENTS_LOAD_SHEDDING_THRESHOLD,
    loadSheddingEnabled: env.EVENTS_LOAD_SHEDDING_ENABLED === "1",
    redis: {
      port: env.PUBSUB_REDIS_PORT,
      host: env.PUBSUB_REDIS_HOST,
      username: env.PUBSUB_REDIS_USERNAME,
      password: env.PUBSUB_REDIS_PASSWORD,
      tlsDisabled: env.PUBSUB_REDIS_TLS_DISABLED === "true",
      clusterMode: env.PUBSUB_REDIS_CLUSTER_MODE_ENABLED === "1",
    },
  });

  new Gauge({
    name: "event_repository_subscriber_count",
    help: "Number of event repository subscribers",
    collect() {
      this.set(repo.subscriberCount);
    },
    registers: [metricsRegister],
  });

  // Add metrics for flush scheduler
  new Gauge({
    name: "event_flush_scheduler_queued_items",
    help: "Total number of items queued in the flush scheduler",
    collect() {
      const status = repo.flushSchedulerStatus;
      this.set(status.queuedItems);
    },
    registers: [metricsRegister],
  });

  new Gauge({
    name: "event_flush_scheduler_batch_queue_length",
    help: "Number of batches waiting to be flushed",
    collect() {
      const status = repo.flushSchedulerStatus;
      this.set(status.batchQueueLength);
    },
    registers: [metricsRegister],
  });

  new Gauge({
    name: "event_flush_scheduler_concurrency",
    help: "Current concurrency level of the flush scheduler",
    collect() {
      const status = repo.flushSchedulerStatus;
      this.set(status.concurrency);
    },
    registers: [metricsRegister],
  });

  new Gauge({
    name: "event_flush_scheduler_active_flushes",
    help: "Number of active flush operations",
    collect() {
      const status = repo.flushSchedulerStatus;
      this.set(status.activeFlushes);
    },
    registers: [metricsRegister],
  });

  new Gauge({
    name: "event_flush_scheduler_dropped_events",
    help: "Total number of events dropped due to load shedding",
    collect() {
      const status = repo.flushSchedulerStatus;
      this.set(status.metrics.droppedEvents);
    },
    registers: [metricsRegister],
  });

  new Gauge({
    name: "event_flush_scheduler_is_load_shedding",
    help: "Whether load shedding is currently active (1 = active, 0 = inactive)",
    collect() {
      const status = repo.flushSchedulerStatus;
      this.set(status.isLoadShedding ? 1 : 0);
    },
    registers: [metricsRegister],
  });

  return repo;
}

export function stripAttributePrefix(attributes: Attributes, prefix: string) {
  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith(prefix)) {
      result[key.slice(prefix.length + 1)] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

export function createExceptionPropertiesFromError(error: TaskRunError): ExceptionEventProperties {
  switch (error.type) {
    case "BUILT_IN_ERROR": {
      return {
        type: error.name,
        message: error.message,
        stacktrace: error.stackTrace,
      };
    }
    case "CUSTOM_ERROR": {
      return {
        type: "Error",
        message: error.raw,
      };
    }
    case "INTERNAL_ERROR": {
      return {
        type: "Internal error",
        message: [error.code, error.message].filter(Boolean).join(": "),
        stacktrace: error.stackTrace,
      };
    }
    case "STRING_ERROR": {
      return {
        type: "Error",
        message: error.raw,
      };
    }
  }
}

/**
 * Filters out partial events from a batch of creatable events, excluding those that have a corresponding full event.
 * @param batch - The batch of creatable events to filter.
 * @returns The filtered array of creatable events, excluding partial events with corresponding full events.
 */
function excludePartialEventsWithCorrespondingFullEvent(batch: CreatableEvent[]): CreatableEvent[] {
  const partialEvents = batch.filter((event) => event.isPartial);
  const fullEvents = batch.filter((event) => !event.isPartial);

  return fullEvents.concat(
    partialEvents.filter((partialEvent) => {
      return !fullEvents.some((fullEvent) => fullEvent.spanId === partialEvent.spanId);
    })
  );
}

export function extractContextFromCarrier(carrier: Record<string, unknown>) {
  const traceparent = carrier["traceparent"];
  const tracestate = carrier["tracestate"];

  if (typeof traceparent !== "string") {
    return undefined;
  }

  return {
    ...carrier,
    traceparent: parseTraceparent(traceparent),
    tracestate,
  };
}

function prepareEvent(event: QueriedEvent): PreparedEvent {
  return {
    ...event,
    duration: Number(event.duration),
    events: parseEventsField(event.events),
    style: parseStyleField(event.style),
  };
}

function prepareDetailedEvent(event: DetailedTraceEvent): PreparedDetailedEvent {
  return {
    ...event,
    duration: Number(event.duration),
    events: parseEventsField(event.events),
    style: parseStyleField(event.style),
  };
}

function parseEventsField(events: Prisma.JsonValue): SpanEvents {
  const unsafe = events
    ? (events as any[]).map((e) => ({
        ...e,
        properties: unflattenAttributes(e.properties as Attributes),
      }))
    : undefined;

  return unsafe as SpanEvents;
}

function parseStyleField(style: Prisma.JsonValue): TaskEventStyle {
  const unsafe = unflattenAttributes(style as Attributes);

  if (!unsafe) {
    return {};
  }

  if (typeof unsafe === "object") {
    return Object.assign(
      {
        icon: undefined,
        variant: undefined,
      },
      unsafe
    ) as TaskEventStyle;
  }

  return {};
}

type AncestorOverrides = {
  isCancelled?: boolean;
  duration?: number;
  isError?: boolean;
  events?: SpanEvents;
};

function getAncestorOverrides({
  spansById,
  span,
}: {
  spansById: Map<string, PreparedEvent>;
  span: PreparedEvent;
}): AncestorOverrides | undefined {
  const overrides: AncestorOverrides = {};

  if (span.level !== "TRACE") {
    return;
  }

  const cancelledAncestor = findCancelledAncestor(spansById, span, span.spanId);

  if (cancelledAncestor) {
    overrides.isCancelled = true;

    // We need to get the cancellation time from the cancellation span event
    const cancellationEvent = cancelledAncestor.events.find(
      (event) => event.name === "cancellation"
    );

    if (cancellationEvent) {
      overrides.duration = calculateDurationFromStart(span.startTime, cancellationEvent.time);
    }

    return overrides;
  }

  const attemptFailedAncestorEvent = findAttemptFailedAncestor(spansById, span, span.spanId);

  if (attemptFailedAncestorEvent) {
    overrides.isError = true;
    overrides.events = [
      {
        name: "exception",
        time: attemptFailedAncestorEvent.time,
        properties: {
          exception: attemptFailedAncestorEvent.properties.exception,
        },
      } satisfies ExceptionSpanEvent,
    ];
    overrides.duration = calculateDurationFromStart(
      span.startTime,
      attemptFailedAncestorEvent.time
    );

    return overrides;
  }

  return;
}

function findCancelledAncestor(
  spansById: Map<string, PreparedEvent>,
  originalSpan: PreparedEvent,
  spanId?: string | null
) {
  if (!spanId) {
    return;
  }

  if (originalSpan.spanId === spanId) {
    return findCancelledAncestor(spansById, originalSpan, originalSpan.parentId);
  }

  const ancestorSpan = spansById.get(spanId);

  if (!ancestorSpan) {
    return;
  }

  if (ancestorSpan.isCancelled) {
    return ancestorSpan;
  }

  if (ancestorSpan.parentId) {
    return findCancelledAncestor(spansById, originalSpan, ancestorSpan.parentId);
  }

  return;
}

function findAttemptFailedAncestor(
  spansById: Map<string, PreparedEvent>,
  originalSpan: PreparedEvent,
  spanId?: string | null
) {
  if (!spanId) {
    return;
  }

  if (originalSpan.spanId === spanId) {
    return findAttemptFailedAncestor(spansById, originalSpan, originalSpan.parentId);
  }

  const ancestorSpan = spansById.get(spanId);

  if (!ancestorSpan) {
    return;
  }

  const attemptFailedEvent = (ancestorSpan.events ?? []).find(
    (event) =>
      event.name === "attempt_failed" &&
      event.properties.attemptNumber === originalSpan.attemptNumber
  );

  if (attemptFailedEvent) {
    return attemptFailedEvent as AttemptFailedSpanEvent;
  }

  if (ancestorSpan.parentId) {
    return findAttemptFailedAncestor(spansById, originalSpan, ancestorSpan.parentId);
  }

  return;
}

function sanitizedAttributes(json: Prisma.JsonValue) {
  if (json === null || json === undefined) {
    return;
  }

  const withoutPrivateProperties = removePrivateProperties(json as Attributes);
  if (!withoutPrivateProperties) {
    return;
  }

  return unflattenAttributes(withoutPrivateProperties);
}
// removes keys that start with a $ sign. If there are no keys left, return undefined
function removePrivateProperties(
  attributes: Attributes | undefined | null
): Attributes | undefined {
  if (!attributes) {
    return undefined;
  }

  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith("$")) {
      continue;
    }

    result[key] = value;
  }

  if (Object.keys(result).length === 0) {
    return undefined;
  }

  return result;
}

function transformEvents(events: SpanEvents, properties: Attributes, isDev: boolean): SpanEvents {
  return (events ?? []).map((event) => transformEvent(event, properties, isDev));
}

function transformEvent(event: SpanEvent, properties: Attributes, isDev: boolean): SpanEvent {
  if (isExceptionSpanEvent(event)) {
    return {
      ...event,
      properties: {
        exception: transformException(event.properties.exception, properties, isDev),
      },
    };
  }

  return event;
}

function transformException(
  exception: ExceptionEventProperties,
  properties: Attributes,
  isDev: boolean
): ExceptionEventProperties {
  const projectDirAttributeValue = properties[SemanticInternalAttributes.PROJECT_DIR];

  if (projectDirAttributeValue !== undefined && typeof projectDirAttributeValue !== "string") {
    return exception;
  }

  return {
    ...exception,
    stacktrace: exception.stacktrace
      ? correctErrorStackTrace(exception.stacktrace, projectDirAttributeValue, {
          removeFirstLine: true,
          isDev,
        })
      : undefined,
  };
}

function calculateDurationFromStart(startTime: bigint, endTime: Date = new Date()) {
  const $endtime = typeof endTime === "string" ? new Date(endTime) : endTime;

  return Number(BigInt($endtime.getTime() * 1_000_000) - startTime);
}

function getNowInNanoseconds(): bigint {
  return BigInt(new Date().getTime() * 1_000_000);
}

export function getDateFromNanoseconds(nanoseconds: bigint) {
  return new Date(Number(nanoseconds) / 1_000_000);
}

function convertDateToNanoseconds(date: Date) {
  return BigInt(date.getTime()) * BigInt(1_000_000);
}

function nanosecondsToMilliseconds(nanoseconds: bigint | number): number {
  return Number(nanoseconds) / 1_000_000;
}

function rehydrateJson(json: Prisma.JsonValue): any {
  if (json === null) {
    return undefined;
  }

  if (json === NULL_SENTINEL) {
    return null;
  }

  if (typeof json === "string") {
    return json;
  }

  if (typeof json === "number") {
    return json;
  }

  if (typeof json === "boolean") {
    return json;
  }

  if (Array.isArray(json)) {
    return json.map((item) => rehydrateJson(item));
  }

  if (typeof json === "object") {
    return unflattenAttributes(json as Attributes);
  }

  return null;
}

function rehydrateShow(properties: Prisma.JsonValue): { actions?: boolean } | undefined {
  if (properties === null || properties === undefined) {
    return;
  }

  if (typeof properties !== "object") {
    return;
  }

  if (Array.isArray(properties)) {
    return;
  }

  const actions = properties[SemanticInternalAttributes.SHOW_ACTIONS];

  if (typeof actions === "boolean") {
    return { actions };
  }

  return;
}

export function rehydrateAttribute<T extends AttributeValue>(
  properties: Prisma.JsonValue,
  key: string
): T | undefined {
  if (properties === null || properties === undefined) {
    return;
  }

  if (typeof properties !== "object") {
    return;
  }

  if (Array.isArray(properties)) {
    return;
  }

  const value = properties[key];

  if (value === undefined) {
    return;
  }

  return value as T;
}

export async function findRunForEventCreation(runId: string) {
  return prisma.taskRun.findFirst({
    where: {
      id: runId,
    },
    select: {
      friendlyId: true,
      taskIdentifier: true,
      traceContext: true,
      runtimeEnvironment: {
        select: {
          id: true,
          type: true,
          organizationId: true,
          projectId: true,
          project: {
            select: {
              externalRef: true,
            },
          },
        },
      },
    },
  });
}

export async function recordRunEvent(
  runId: string,
  message: string,
  options: Omit<TraceEventOptions, "environment" | "taskSlug" | "startTime"> & {
    duration?: number;
    parentId?: string;
    startTime?: Date;
  }
): Promise<
  | {
      success: true;
    }
  | {
      success: false;
      code: "RUN_NOT_FOUND" | "FAILED_TO_RECORD_EVENT";
      error?: unknown;
    }
> {
  try {
    const foundRun = await findRunForEventCreation(runId);

    if (!foundRun) {
      logger.error("Failed to find run for event creation", { runId });
      return {
        success: false,
        code: "RUN_NOT_FOUND",
      };
    }

    const { attributes, startTime, ...optionsRest } = options;

    await eventRepository.recordEvent(message, {
      environment: foundRun.runtimeEnvironment,
      taskSlug: foundRun.taskIdentifier,
      context: foundRun.traceContext as Record<string, string | undefined>,
      attributes: {
        runId: foundRun.friendlyId,
        ...attributes,
      },
      startTime: BigInt((startTime?.getTime() ?? Date.now()) * 1_000_000),
      ...optionsRest,
    });

    return {
      success: true,
    };
  } catch (error) {
    logger.error("Failed to record event for run", {
      error: error instanceof Error ? error.message : error,
      runId,
    });

    return {
      success: false,
      code: "FAILED_TO_RECORD_EVENT",
      error,
    };
  }
}

export async function recordRunDebugLog(
  runId: string,
  message: string,
  options: Omit<TraceEventOptions, "environment" | "taskSlug" | "startTime"> & {
    duration?: number;
    parentId?: string;
    startTime?: Date;
  }
): Promise<
  | {
      success: true;
    }
  | {
      success: false;
      code: "RUN_NOT_FOUND" | "FAILED_TO_RECORD_EVENT";
      error?: unknown;
    }
> {
  return recordRunEvent(runId, message, {
    ...options,
    attributes: {
      ...options?.attributes,
      isDebug: true,
    },
  });
}

/**
 * Extracts error details from Prisma errors in a type-safe way.
 * Only includes 'code' property for PrismaClientKnownRequestError.
 */
function getPrismaErrorDetails(
  error: Prisma.PrismaClientUnknownRequestError | Prisma.PrismaClientKnownRequestError
): {
  name: string;
  message: string;
  stack: string | undefined;
  clientVersion: string;
  code?: string;
} {
  const base = {
    name: error.name,
    message: error.message,
    stack: error.stack,
    clientVersion: error.clientVersion,
  };

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return { ...base, code: error.code };
  }

  return base;
}

/**
 * Checks if a PrismaClientKnownRequestError is a Unicode/hex escape error.
 */
function isUnicodeError(error: Prisma.PrismaClientKnownRequestError): boolean {
  return (
    error.message.includes("lone leading surrogate in hex escape") ||
    error.message.includes("unexpected end of hex escape") ||
    error.message.includes("invalid Unicode") ||
    error.message.includes("invalid escape sequence")
  );
}

/**
 * Determines if a Prisma error should be retried with bisection logic.
 * Returns true for errors that might be resolved by splitting the batch.
 */
function isRetriablePrismaError(
  error: unknown
): error is Prisma.PrismaClientUnknownRequestError | Prisma.PrismaClientKnownRequestError {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    // Always retry unknown errors with bisection
    return true;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Only retry known errors if they're Unicode/hex escape related
    return isUnicodeError(error);
  }

  return false;
}

function isEmptyObject(obj: object) {
  for (var prop in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, prop)) {
      return false;
    }
  }

  return true;
}
// Helper function to check if a field is empty/missing
function isEmpty(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "object" && !Array.isArray(value) && isEmptyObject(value)) return true;
  return false;
}
