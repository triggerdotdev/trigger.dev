import { Attributes, AttributeValue, trace, Tracer } from "@opentelemetry/api";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
  AttemptFailedSpanEvent,
  correctErrorStackTrace,
  ExceptionEventProperties,
  ExceptionSpanEvent,
  flattenAttributes,
  isExceptionSpanEvent,
  nanosecondsToMilliseconds,
  omit,
  PRIMARY_VARIANT,
  SemanticInternalAttributes,
  SpanEvent,
  SpanEvents,
  TaskEventStyle,
  TaskRunError,
  unflattenAttributes,
} from "@trigger.dev/core/v3";
import { serializeTraceparent } from "@trigger.dev/core/v3/isomorphic";
import { Prisma, TaskEvent, TaskEventKind } from "@trigger.dev/database";
import { nanoid } from "nanoid";
import { Gauge } from "prom-client";
import { $replica, prisma, PrismaClient, PrismaReplicaClient } from "~/db.server";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { DynamicFlushScheduler } from "../dynamicFlushScheduler.server";
import { tracePubSub } from "../services/tracePubSub.server";
import { DetailedTraceEvent, TaskEventStore, TaskEventStoreTable } from "../taskEventStore.server";
import { startActiveSpan } from "../tracer.server";
import { startSpan } from "../tracing.server";
import {
  calculateDurationFromStart,
  convertDateToNanoseconds,
  createExceptionPropertiesFromError,
  extractContextFromCarrier,
  generateDeterministicSpanId,
  generateSpanId,
  generateTraceId,
  getDateFromNanoseconds,
  getNowInNanoseconds,
  parseEventsField,
  stripAttributePrefix,
  removePrivateProperties,
  isEmptyObject,
} from "./common.server";
import type {
  CompleteableTaskRun,
  CreateEventInput,
  EventBuilder,
  EventRepoConfig,
  IEventRepository,
  PreparedDetailedEvent,
  PreparedEvent,
  QueriedEvent,
  RunPreparedEvent,
  SpanDetail,
  SpanDetailedSummary,
  SpanSummary,
  TaskEventRecord,
  TraceAttributes,
  TraceDetailedSummary,
  TraceEventOptions,
  TraceSummary,
} from "./eventRepository.types";
import { originalRunIdCache } from "./originalRunIdCache.server";

const MAX_FLUSH_DEPTH = 5;

export class EventRepository implements IEventRepository {
  private readonly _flushScheduler: DynamicFlushScheduler<Prisma.TaskEventCreateManyInput>;
  private _randomIdGenerator = new RandomIdGenerator();
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
      isDroppableEvent: (event: Prisma.TaskEventCreateManyInput) => {
        // Only drop LOG events during load shedding
        return event.kind === TaskEventKind.LOG;
      },
    });

    this._tracer = _config.tracer ?? trace.getTracer("eventRepo", "0.0.1");

    // Instantiate the store using the partitioning flag.
    this.taskEventStore = new TaskEventStore(db, readReplica);
  }

  #createableEventToPrismaEvent(event: CreateEventInput): Prisma.TaskEventCreateManyInput {
    return {
      message: event.message,
      traceId: event.traceId,
      spanId: event.spanId,
      parentId: event.parentId,
      isError: event.isError,
      isPartial: event.isPartial,
      isCancelled: event.isCancelled,
      isDebug: false,
      serviceName: "",
      serviceNamespace: "",
      level: event.level,
      kind: event.kind,
      status: event.status,
      links: [],
      events: event.events,
      startTime: event.startTime,
      duration: event.duration,
      attemptNumber: event.attemptNumber,
      environmentId: event.environmentId,
      environmentType: event.environmentType,
      organizationId: event.organizationId,
      projectId: event.projectId,
      projectRef: "",
      runId: event.runId,
      runIsTest: false,
      taskSlug: event.taskSlug,
      properties: event.properties as Prisma.InputJsonValue,
      metadata: event.metadata as Prisma.InputJsonValue,
      style: event.style as Prisma.InputJsonValue,
    };
  }

  private async insertImmediate(event: CreateEventInput) {
    await this.#flushBatch(nanoid(), [this.#createableEventToPrismaEvent(event)]);
  }

  async insertMany(events: CreateEventInput[]) {
    this._flushScheduler.addToBatch(events.map(this.#createableEventToPrismaEvent));
  }

  async insertManyImmediate(events: CreateEventInput[]) {
    await this.#flushBatchWithReturn(nanoid(), events.map(this.#createableEventToPrismaEvent));
  }

  async completeSuccessfulRunEvent({ run, endTime }: { run: CompleteableTaskRun; endTime?: Date }) {
    const startTime = convertDateToNanoseconds(run.createdAt);

    await this.insertImmediate({
      message: run.taskIdentifier,
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      projectId: run.projectId,
      taskSlug: run.taskIdentifier,
      environmentId: run.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: false,
      isCancelled: false,
      status: "OK",
      startTime,
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()),
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
      level: "TRACE",
      kind: "SERVER",
      traceId: blockedRun.traceId,
      spanId: spanId,
      parentId: parentSpanId,
      runId: blockedRun.friendlyId,
      projectId: run.projectId,
      taskSlug: run.taskIdentifier,
      environmentId: run.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError,
      isCancelled: false,
      status: "OK",
      startTime,
      properties: {},
      metadata: undefined,
      style: undefined,
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()),
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
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      projectId: run.projectId,
      taskSlug: run.taskIdentifier,
      environmentId: run.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: true,
      isCancelled: false,
      status: "ERROR",
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
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      projectId: run.projectId,
      taskSlug: run.taskIdentifier,
      environmentId: run.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: true,
      isCancelled: false,
      status: "ERROR",
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
      level: "TRACE",
      kind: "UNSPECIFIED", // This will be treated as an "invisible" event
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      projectId: run.projectId,
      taskSlug: run.taskIdentifier,
      environmentId: run.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: true,
      isError: false,
      isCancelled: false,
      status: "OK",
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
      level: "TRACE",
      kind: "SERVER",
      traceId: run.traceId,
      spanId: run.spanId,
      parentId: run.parentSpanId,
      runId: run.friendlyId,
      projectId: run.projectId,
      taskSlug: run.taskIdentifier,
      environmentId: run.runtimeEnvironmentId,
      environmentType: "DEVELOPMENT",
      organizationId: run.organizationId ?? "",
      isPartial: false,
      isError: true,
      isCancelled: true,
      status: "ERROR",
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
    });
  }

  public async getTraceSummary(
    storeTable: TaskEventStoreTable,
    environmentId: string,
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
    environmentId: string,
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
            events: events?.filter((e) => !e.name.startsWith("trigger.dev")),
            startTime: getDateFromNanoseconds(event.startTime),
            duration: nanosecondsToMilliseconds(duration),
            isError,
            isPartial,
            isCancelled,
            level: event.level,
            properties,
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
    environmentId: string,
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
    environmentId: string,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<SpanDetail | undefined> {
    return await startActiveSpan("getSpan", async (s) => {
      const spanEvent = await this.#getSpanEvent({
        storeTable,
        spanId,
        environmentId,
        startCreatedAt,
        endCreatedAt,
        options,
      });

      if (!spanEvent) {
        return;
      }

      const preparedEvent = prepareEvent(spanEvent);

      const span = await this.#createSpanFromEvent(
        storeTable,
        preparedEvent,
        environmentId,
        startCreatedAt,
        endCreatedAt
      );

      const properties = sanitizedAttributes(spanEvent.properties);

      const spanEvents = transformEvents(
        span.data.events,
        spanEvent.metadata as Attributes,
        spanEvent.environmentType === "DEVELOPMENT"
      );

      // Used for waitpoint token spans
      const entity = {
        type: rehydrateAttribute<string>(
          spanEvent.properties,
          SemanticInternalAttributes.ENTITY_TYPE
        ),
        id: rehydrateAttribute<string>(spanEvent.properties, SemanticInternalAttributes.ENTITY_ID),
      };

      return {
        // Core Identity & Structure
        spanId: spanEvent.spanId,
        parentId: spanEvent.parentId,
        message: spanEvent.message,

        // Status & State
        isError: span.data.isError,
        isPartial: span.data.isPartial,
        isCancelled: span.data.isCancelled,
        level: spanEvent.level,
        kind: spanEvent.kind,

        // Timing
        startTime: span.data.startTime,
        duration: nanosecondsToMilliseconds(span.data.duration),

        // Content & Display
        events: spanEvents,
        style: span.data.style,
        properties: properties,

        // Entity & Relationships
        entity,

        // Additional properties
        metadata: spanEvent.metadata,
      };
    });
  }

  async getSpanOriginalRunId(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<string | undefined> {
    return await startActiveSpan("getSpanOriginalRunId", async (s) => {
      return await originalRunIdCache.swr(traceId, spanId, async () => {
        const spanEvent = await this.#getSpanEvent(
          storeTable,
          spanId,
          startCreatedAt,
          endCreatedAt,
          { includeDebugLogs: false }
        );

        if (!spanEvent) {
          return;
        }
        // This is used when the span is a cached run (because of idempotency key)
        // so this span isn't the actual run span, but points to the original run
        const originalRun = rehydrateAttribute<string>(
          spanEvent.properties,
          SemanticInternalAttributes.ORIGINAL_RUN_ID
        );

        return originalRun;
      });
    });
  }

  async #createSpanFromEvent(
    storeTable: TaskEventStoreTable,
    event: PreparedEvent,
    environmentId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ) {
    return await startActiveSpan("createSpanFromEvent", async (s) => {
      let overrides: AncestorOverrides | undefined;

      if (!event.isCancelled && event.isPartial) {
        await this.#walkSpanAncestors(
          storeTable,
          event,
          environmentId,
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
        },
      };

      return span;
    });
  }

  async #walkSpanAncestors(
    storeTable: TaskEventStoreTable,
    event: PreparedEvent,
    environmentId: string,
    startCreatedAt: Date,
    endCreatedAt: Date | undefined,
    callback: (event: PreparedEvent, level: number) => { stop: boolean }
  ) {
    const parentId = event.parentId;
    if (!parentId) {
      return;
    }

    await startActiveSpan("walkSpanAncestors", async (s) => {
      let parentEvent = await this.#getSpanEvent({
        storeTable,
        spanId: parentId,
        environmentId,
        startCreatedAt,
        endCreatedAt,
      });
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

        parentEvent = await this.#getSpanEvent({
          storeTable,
          spanId: preparedParentEvent.parentId,
          environmentId,
          startCreatedAt,
          endCreatedAt,
        });

        level++;
      }
    });
  }

  async #getSpanEvent({
    storeTable,
    spanId,
    environmentId,
    startCreatedAt,
    endCreatedAt,
    options,
  }: {
    storeTable: TaskEventStoreTable;
    spanId: string;
    environmentId: string;
    startCreatedAt: Date;
    endCreatedAt?: Date;
    options?: { includeDebugLogs?: boolean };
  }) {
    return await startActiveSpan("getSpanEvent", async (s) => {
      const events = await this.taskEventStore.findMany(
        storeTable,
        { spanId, environmentId },
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

    const traceId = propagatedContext?.traceparent?.traceId ?? generateTraceId();
    const parentId = options.parentId ?? propagatedContext?.traceparent?.spanId;
    const tracestate = propagatedContext?.tracestate;
    const spanId = options.spanIdSeed
      ? generateDeterministicSpanId(traceId, options.spanIdSeed)
      : generateSpanId();

    const metadata = {
      [SemanticInternalAttributes.ENVIRONMENT_ID]: options.environment.id,
      [SemanticInternalAttributes.ENVIRONMENT_TYPE]: options.environment.type,
      [SemanticInternalAttributes.ORGANIZATION_ID]: options.environment.organizationId,
      [SemanticInternalAttributes.PROJECT_ID]: options.environment.projectId,
      [SemanticInternalAttributes.PROJECT_REF]: options.environment.project.externalRef,
      [SemanticInternalAttributes.RUN_ID]: options.attributes.runId,
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

    const event: CreateEventInput = {
      traceId,
      spanId,
      parentId,
      message: message,
      level: options.attributes.isDebug ? "WARN" : "TRACE",
      kind: options.attributes.isDebug ? TaskEventKind.LOG : options.kind,
      status: "OK",
      startTime,
      isPartial: false,
      duration, // convert to nanoseconds
      environmentId: options.environment.id,
      environmentType: options.environment.type,
      organizationId: options.environment.organizationId,
      runId: options.attributes.runId,
      projectId: options.environment.projectId,
      taskSlug: options.taskSlug,
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
    };

    if (options.immediate) {
      await this.insertImmediate(event);
    } else {
      this._flushScheduler.addToBatch([this.#createableEventToPrismaEvent(event)]);
    }
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
      ? generateTraceId()
      : propagatedContext?.traceparent?.traceId ?? generateTraceId();
    const parentId = options.spanParentAsLink ? undefined : propagatedContext?.traceparent?.spanId;
    const tracestate = options.spanParentAsLink ? undefined : propagatedContext?.tracestate;
    const spanId = options.spanIdSeed
      ? generateDeterministicSpanId(traceId, options.spanIdSeed)
      : generateSpanId();

    const traceContext = {
      ...options.context,
      traceparent: serializeTraceparent(traceId, spanId),
    };

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

    const event: CreateEventInput = {
      traceId,
      spanId,
      parentId,
      duration: options.incomplete ? 0 : duration,
      isPartial: failedWithError ? false : options.incomplete,
      isError: options.isError === true || !!failedWithError,
      message: message,
      level: "TRACE",
      kind: options.kind,
      status: failedWithError ? "ERROR" : "OK",
      startTime,
      environmentId: options.environment.id,
      environmentType: options.environment.type,
      organizationId: options.environment.organizationId,
      projectId: options.environment.projectId,
      runId: options.attributes.runId,
      taskSlug: options.taskSlug,
      properties: {
        ...(flattenAttributes(metadata, SemanticInternalAttributes.METADATA) as Record<
          string,
          string
        >),
        ...flattenAttributes(options.attributes.properties),
      },
      metadata: metadata,
      style: stripAttributePrefix(style, SemanticInternalAttributes.STYLE),
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
      this._flushScheduler.addToBatch([this.#createableEventToPrismaEvent(event)]);
    }

    return result;
  }

  async #flushBatch(flushId: string, batch: Prisma.TaskEventCreateManyInput[]) {
    await startSpan(this._tracer, "flushBatch", async (span) => {
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

  async #flushBatchWithReturn(
    flushId: string,
    batch: Prisma.TaskEventCreateManyInput[]
  ): Promise<Prisma.TaskEventCreateManyInput[]> {
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

      return flushedEvents;
    });
  }

  private get taskEventStoreTable(): TaskEventStoreTable {
    return this._config.partitioningEnabled ? "taskEventPartitioned" : "taskEvent";
  }

  async #doFlushBatch(
    flushId: string,
    events: Prisma.TaskEventCreateManyInput[],
    depth: number = 1
  ): Promise<Prisma.TaskEventCreateManyInput[]> {
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

  async #publishToRedis(events: Prisma.TaskEventCreateManyInput[]) {
    if (events.length === 0) return;

    await tracePubSub.publish(events.map((e) => e.traceId));
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

/**
 * Filters out partial events from a batch of creatable events, excluding those that have a corresponding full event.
 * @param batch - The batch of creatable events to filter.
 * @returns The filtered array of creatable events, excluding partial events with corresponding full events.
 */
function excludePartialEventsWithCorrespondingFullEvent(
  batch: Prisma.TaskEventCreateManyInput[]
): Prisma.TaskEventCreateManyInput[] {
  const partialEvents = batch.filter((event) => event.isPartial);
  const fullEvents = batch.filter((event) => !event.isPartial);

  return fullEvents.concat(
    partialEvents.filter((partialEvent) => {
      return !fullEvents.some((fullEvent) => fullEvent.spanId === partialEvent.spanId);
    })
  );
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
  if (span.level !== "TRACE") {
    return;
  }

  if (!span.isPartial) {
    return;
  }

  const overrides: AncestorOverrides = {};

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
// Helper function to check if a field is empty/missing
function isEmpty(value: any): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "object" && !Array.isArray(value) && isEmptyObject(value)) return true;
  return false;
}
