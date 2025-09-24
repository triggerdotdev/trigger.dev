import type {
  ClickHouse,
  TaskEventDetailsV1Result,
  TaskEventSummaryV1Result,
  TaskEventV1Input,
} from "@internal/clickhouse";
import { Attributes, startSpan, trace, Tracer } from "@internal/tracing";
import { createJsonErrorObject } from "@trigger.dev/core/v3/errors";
import { serializeTraceparent } from "@trigger.dev/core/v3/isomorphic";
import {
  AttemptFailedSpanEvent,
  CancellationSpanEvent,
  ExceptionSpanEvent,
  isAttemptFailedSpanEvent,
  isCancellationSpanEvent,
  isExceptionSpanEvent,
  OtherSpanEvent,
  PRIMARY_VARIANT,
  SpanEvents,
  TaskEventStyle,
  TaskRunError,
} from "@trigger.dev/core/v3/schemas";
import { SemanticInternalAttributes } from "@trigger.dev/core/v3/semanticInternalAttributes";
import { unflattenAttributes } from "@trigger.dev/core/v3/utils/flattenAttributes";
import { TaskEventLevel } from "@trigger.dev/database";
import { logger } from "~/services/logger.server";
import { DynamicFlushScheduler } from "../dynamicFlushScheduler.server";
import { tracePubSub } from "../services/tracePubSub.server";
import type { TaskEventStoreTable } from "../taskEventStore.server";
import {
  calculateDurationFromStart,
  calculateDurationFromStartJsDate,
  convertDateToNanoseconds,
  createExceptionPropertiesFromError,
  extractContextFromCarrier,
  generateDeterministicSpanId,
  generateSpanId,
  generateTraceId,
  getNowInNanoseconds,
  parseEventsField,
  removePrivateProperties,
  isEmptyObject,
} from "./common.server";
import type {
  CompleteableTaskRun,
  CreateEventInput,
  EventBuilder,
  IEventRepository,
  RunPreparedEvent,
  SpanDetail,
  SpanOverride,
  SpanSummary,
  TraceAttributes,
  TraceDetailedSummary,
  TraceEventOptions,
  TraceSummary,
} from "./eventRepository.types";
import { originalRunIdCache } from "./originalRunIdCache.server";

export type ClickhouseEventRepositoryConfig = {
  clickhouse: ClickHouse;
  batchSize?: number;
  flushInterval?: number;
  tracer?: Tracer;
  maximumTraceSummaryViewCount?: number;
};

/**
 * ClickHouse-based implementation of the EventRepository.
 * This implementation stores events in ClickHouse for better analytics and performance.
 */
export class ClickhouseEventRepository implements IEventRepository {
  private _clickhouse: ClickHouse;
  private _config: ClickhouseEventRepositoryConfig;
  private readonly _flushScheduler: DynamicFlushScheduler<TaskEventV1Input>;
  private _tracer: Tracer;

  constructor(config: ClickhouseEventRepositoryConfig) {
    this._clickhouse = config.clickhouse;
    this._config = config;
    this._tracer = config.tracer ?? trace.getTracer("clickhouseEventRepo", "0.0.1");

    this._flushScheduler = new DynamicFlushScheduler({
      batchSize: config.batchSize ?? 1000,
      flushInterval: config.flushInterval ?? 1000,
      callback: this.#flushBatch.bind(this),
      minConcurrency: 1,
      maxConcurrency: 10,
      maxBatchSize: 10000,
      memoryPressureThreshold: 10000,
      loadSheddingThreshold: 10000,
      loadSheddingEnabled: false,
      isDroppableEvent: (event: TaskEventV1Input) => {
        // Only drop LOG events during load shedding
        return event.kind === "DEBUG_EVENT";
      },
    });
  }

  async #flushBatch(flushId: string, events: TaskEventV1Input[]) {
    await startSpan(this._tracer, "flushBatch", async (span) => {
      span.setAttribute("flush_id", flushId);
      span.setAttribute("event_count", events.length);

      logger.debug("ClickhouseEventRepository.flushBatch", {
        events,
      });

      const [insertError, insertResult] = await this._clickhouse.taskEvents.insert(events);

      if (insertError) {
        throw insertError;
      }

      logger.info("ClickhouseEventRepository.flushBatch Inserted batch into clickhouse", {
        events: events.length,
        insertResult,
      });

      this.#publishToRedis(events);
    });
  }

  async #publishToRedis(events: TaskEventV1Input[]) {
    if (events.length === 0) return;
    await tracePubSub.publish(events.map((e) => e.trace_id));
  }

  async insertMany(events: CreateEventInput[]): Promise<void> {
    this.addToBatch(events.flatMap((event) => this.createEventToTaskEventV1Input(event)));
  }

  async insertManyImmediate(events: CreateEventInput[]): Promise<void> {
    this.insertMany(events);
  }

  private createEventToTaskEventV1Input(event: CreateEventInput): TaskEventV1Input[] {
    return [
      {
        environment_id: event.environmentId,
        organization_id: event.organizationId,
        project_id: event.projectId,
        task_identifier: event.taskSlug,
        run_id: event.runId,
        start_time: event.startTime.toString(),
        duration: (event.duration ?? 0).toString(),
        trace_id: event.traceId,
        span_id: event.spanId,
        parent_span_id: event.parentId ?? "",
        message: event.message,
        kind: this.createEventToTaskEventV1InputKind(event),
        status: this.createEventToTaskEventV1InputStatus(event),
        attributes: this.createEventToTaskEventV1InputAttributes(event.properties),
        metadata: this.createEventToTaskEventV1InputMetadata(event),
        expires_at: convertDateToClickhouseDateTime(
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // TODO: make sure configurable and by org
        ),
      },
      ...this.spanEventsToTaskEventV1Input(event),
    ];
  }

  private spanEventsToTaskEventV1Input(event: CreateEventInput): TaskEventV1Input[] {
    if (!event.events) return [];

    const spanEvents = parseEventsField(event.events);

    const records = spanEvents.map((e) => this.createTaskEventV1InputFromSpanEvent(e, event));

    if (event.isPartial) {
      return records;
    }

    // Only return events where the event start_time is greater than the span start_time
    return records.filter((r) => BigInt(r.start_time) > BigInt(event.startTime));
  }

  private createTaskEventV1InputFromSpanEvent(
    spanEvent: SpanEvents[number],
    event: CreateEventInput
  ): TaskEventV1Input {
    if (isExceptionSpanEvent(spanEvent)) {
      return this.createTaskEventV1InputFromExceptionEvent(spanEvent, event);
    }

    if (isCancellationSpanEvent(spanEvent)) {
      return this.createTaskEventV1InputFromCancellationEvent(spanEvent, event);
    }

    if (isAttemptFailedSpanEvent(spanEvent)) {
      return this.createTaskEventV1InputFromAttemptFailedEvent(spanEvent, event);
    }

    return this.createTaskEventV1InputFromOtherEvent(spanEvent, event);
  }

  private createTaskEventV1InputFromExceptionEvent(
    spanEvent: ExceptionSpanEvent,
    event: CreateEventInput
  ): TaskEventV1Input {
    return {
      environment_id: event.environmentId,
      organization_id: event.organizationId,
      project_id: event.projectId,
      task_identifier: event.taskSlug,
      run_id: event.runId,
      start_time: convertDateToNanoseconds(spanEvent.time).toString(),
      duration: "0", // Events have no duration
      trace_id: event.traceId,
      span_id: event.spanId,
      parent_span_id: event.parentId ?? "",
      message: spanEvent.name,
      kind: "SPAN_EVENT",
      status: "ERROR",
      attributes: {
        error: {
          message: spanEvent.properties.exception.message,
          name: spanEvent.properties.exception.type,
          stackTrace: spanEvent.properties.exception.stacktrace,
        },
      },
      metadata: JSON.stringify({
        exception: spanEvent.properties.exception,
      }), // Events have no metadata
      expires_at: convertDateToClickhouseDateTime(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // TODO: make sure configurable and by org
      ),
    };
  }

  private createTaskEventV1InputFromCancellationEvent(
    spanEvent: CancellationSpanEvent,
    event: CreateEventInput
  ): TaskEventV1Input {
    return {
      environment_id: event.environmentId,
      organization_id: event.organizationId,
      project_id: event.projectId,
      task_identifier: event.taskSlug,
      run_id: event.runId,
      start_time: convertDateToNanoseconds(spanEvent.time).toString(),
      duration: "0", // Events have no duration
      trace_id: event.traceId,
      span_id: event.spanId,
      parent_span_id: event.parentId ?? "",
      message: spanEvent.name,
      kind: "SPAN_EVENT",
      status: "CANCELLED",
      attributes: {},
      metadata: JSON.stringify({
        reason: spanEvent.properties.reason,
      }), // Events have no metadata
      expires_at: convertDateToClickhouseDateTime(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // TODO: make sure configurable and by org
      ),
    };
  }

  private createTaskEventV1InputFromAttemptFailedEvent(
    spanEvent: AttemptFailedSpanEvent,
    event: CreateEventInput
  ): TaskEventV1Input {
    return {
      environment_id: event.environmentId,
      organization_id: event.organizationId,
      project_id: event.projectId,
      task_identifier: event.taskSlug,
      run_id: event.runId,
      start_time: convertDateToNanoseconds(spanEvent.time).toString(),
      duration: "0", // Events have no duration
      trace_id: event.traceId,
      span_id: event.spanId,
      parent_span_id: event.parentId ?? "",
      message: spanEvent.name,
      kind: "ANCESTOR_OVERRIDE",
      status: "OK",
      attributes: {
        error: {
          message: spanEvent.properties.exception.message,
          name: spanEvent.properties.exception.type,
          stackTrace: spanEvent.properties.exception.stacktrace,
        },
      },
      metadata: JSON.stringify(spanEvent.properties),
      expires_at: convertDateToClickhouseDateTime(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // TODO: make sure configurable and by org
      ),
    };
  }

  private createTaskEventV1InputFromOtherEvent(
    spanEvent: OtherSpanEvent,
    event: CreateEventInput
  ): TaskEventV1Input {
    return {
      environment_id: event.environmentId,
      organization_id: event.organizationId,
      project_id: event.projectId,
      task_identifier: event.taskSlug,
      run_id: event.runId,
      start_time: convertDateToNanoseconds(spanEvent.time).toString(),
      duration: "0", // Events have no duration
      trace_id: event.traceId,
      span_id: event.spanId,
      parent_span_id: event.parentId ?? "",
      message: spanEvent.name,
      kind: "SPAN_EVENT",
      status: "OK",
      attributes: {},
      metadata: JSON.stringify(unflattenAttributes(spanEvent.properties as Attributes)),
      expires_at: convertDateToClickhouseDateTime(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // TODO: make sure configurable and by org
      ),
    };
  }

  private createEventToTaskEventV1InputKind(event: CreateEventInput): string {
    if (event.kind === "UNSPECIFIED") {
      return "ANCESTOR_OVERRIDE";
    }

    if (event.level === "TRACE") {
      return "SPAN";
    }

    if (event.isDebug) {
      return "DEBUG_EVENT";
    }

    return `LOG_${(event.level ?? "LOG").toUpperCase()}`;
  }

  private createEventToTaskEventV1InputStatus(event: CreateEventInput): string {
    if (event.isPartial) {
      return "PARTIAL";
    }

    if (event.isError) {
      return "ERROR";
    }

    if (event.isCancelled) {
      return "CANCELLED";
    }

    return "OK";
  }

  private createEventToTaskEventV1InputAttributes(attributes: Attributes): Record<string, unknown> {
    const publicAttributes = removePrivateProperties(attributes);

    if (!publicAttributes) {
      return {};
    }

    const unflattenedAttributes = unflattenAttributes(publicAttributes);

    if (unflattenedAttributes && typeof unflattenedAttributes === "object") {
      return {
        ...unflattenedAttributes,
      };
    }

    return {};
  }

  private createEventToTaskEventV1InputMetadata(event: CreateEventInput): string {
    return JSON.stringify({
      style: event.style ? unflattenAttributes(event.style) : undefined,
      attemptNumber: event.attemptNumber,
      entity: this.extractEntityFromAttributes(event.properties),
    });
  }

  private extractEntityFromAttributes(
    attributes: Attributes
  ): { entityType: string; entityId?: string } | undefined {
    if (!attributes || typeof attributes !== "object") {
      return undefined;
    }

    const entityType = attributes[SemanticInternalAttributes.ENTITY_TYPE];
    const entityId = attributes[SemanticInternalAttributes.ENTITY_ID];

    if (typeof entityType !== "string") {
      return undefined;
    }

    return { entityType, entityId: entityId as string | undefined };
  }

  private addToBatch(events: TaskEventV1Input[] | TaskEventV1Input) {
    this._flushScheduler.addToBatch(Array.isArray(events) ? events : [events]);
  }

  // Event recording methods
  async recordEvent(
    message: string,
    options: TraceEventOptions & { duration?: number; parentId?: string }
  ): Promise<void> {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const startTime = options.startTime ?? getNowInNanoseconds();
    const duration =
      options.duration ??
      (options.endTime ? calculateDurationFromStart(startTime, options.endTime) : 100);

    const traceId = propagatedContext?.traceparent?.traceId ?? generateTraceId();
    const parentId = options.parentId ?? propagatedContext?.traceparent?.spanId;
    const spanId = options.spanIdSeed
      ? generateDeterministicSpanId(traceId, options.spanIdSeed)
      : generateSpanId();

    if (!options.attributes.runId) {
      throw new Error("runId is required");
    }

    const kind = options.attributes.isDebug ? "DEBUG_EVENT" : "SPAN";

    const metadata = {
      style: {
        icon: options.attributes.isDebug ? "warn" : "play",
      },
      ...options.attributes.metadata,
    };

    const event: TaskEventV1Input = {
      environment_id: options.environment.id,
      organization_id: options.environment.organizationId,
      project_id: options.environment.projectId,
      task_identifier: options.taskSlug,
      run_id: options.attributes.runId,
      start_time: startTime.toString(),
      duration: duration.toString(),
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentId ?? "",
      message,
      kind,
      status: "OK",
      attributes: options.attributes.properties
        ? this.createEventToTaskEventV1InputAttributes(options.attributes.properties)
        : undefined,
      metadata: JSON.stringify(metadata),
      // TODO: make sure configurable and by org
      expires_at: convertDateToClickhouseDateTime(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    };

    this._flushScheduler.addToBatch([event]);
  }

  async traceEvent<TResult>(
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

    if (!options.attributes.runId) {
      throw new Error("runId is required");
    }

    const metadata = {
      style: {
        icon: "task",
        variant: PRIMARY_VARIANT,
        ...options.attributes.style,
      },
      ...options.attributes.metadata,
    };

    const event: TaskEventV1Input = {
      environment_id: options.environment.id,
      organization_id: options.environment.organizationId,
      project_id: options.environment.projectId,
      task_identifier: options.taskSlug,
      run_id: options.attributes.runId,
      start_time: startTime.toString(),
      duration: String(options.incomplete ? 0 : duration),
      trace_id: traceId,
      span_id: spanId,
      parent_span_id: parentId ?? "",
      message,
      kind: "SPAN",
      status: failedWithError ? "ERROR" : options.incomplete ? "PARTIAL" : "OK",
      attributes: options.attributes.properties
        ? this.createEventToTaskEventV1InputAttributes(options.attributes.properties)
        : {},
      metadata: JSON.stringify(metadata),
      // TODO: make sure configurable and by org
      expires_at: convertDateToClickhouseDateTime(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)),
    };

    const originalRunId =
      options.attributes.properties?.[SemanticInternalAttributes.ORIGINAL_RUN_ID];

    if (typeof originalRunId === "string") {
      await originalRunIdCache.set(traceId, spanId, originalRunId);
    }

    const events = [event];

    if (failedWithError) {
      const error = createJsonErrorObject(failedWithError);

      events.push({
        environment_id: options.environment.id,
        organization_id: options.environment.organizationId,
        project_id: options.environment.projectId,
        task_identifier: options.taskSlug,
        run_id: options.attributes.runId,
        start_time: startTime.toString(),
        duration: String(options.incomplete ? 0 : duration),
        trace_id: traceId,
        span_id: spanId,
        parent_span_id: parentId ?? "",
        message: "exception",
        kind: "SPAN_EVENT",
        status: "ERROR",
        attributes: {
          error,
        },
        metadata: JSON.stringify({
          exception: createExceptionPropertiesFromError(failedWithError),
        }),
        // TODO: make sure configurable and by org
        expires_at: convertDateToClickhouseDateTime(
          new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        ),
      });
    }

    this._flushScheduler.addToBatch(events);

    return result;
  }

  // Run event completion methods
  async completeSuccessfulRunEvent({
    run,
    endTime,
  }: {
    run: CompleteableTaskRun;
    endTime?: Date;
  }): Promise<void> {
    if (!run.organizationId) {
      return;
    }

    const startTime = convertDateToNanoseconds(run.createdAt);
    const expiresAt = convertDateToClickhouseDateTime(
      new Date(run.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    );

    const event: TaskEventV1Input = {
      environment_id: run.runtimeEnvironmentId,
      organization_id: run.organizationId,
      project_id: run.projectId,
      task_identifier: run.taskIdentifier,
      run_id: run.friendlyId,
      start_time: startTime.toString(),
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()).toString(),
      trace_id: run.traceId,
      span_id: run.spanId,
      parent_span_id: run.parentSpanId ?? "",
      message: run.taskIdentifier,
      kind: "SPAN",
      status: "OK",
      attributes: {},
      metadata: "{}",
      expires_at: expiresAt,
    };

    this.addToBatch(event);
  }

  async completeCachedRunEvent({
    run,
    blockedRun,
    spanId,
    parentSpanId,
    spanCreatedAt,
    isError,
    endTime,
  }: {
    run: CompleteableTaskRun;
    blockedRun: CompleteableTaskRun;
    spanId: string;
    parentSpanId: string;
    spanCreatedAt: Date;
    isError: boolean;
    endTime?: Date;
  }): Promise<void> {
    if (!run.organizationId) {
      return;
    }

    const startTime = convertDateToNanoseconds(spanCreatedAt);
    const expiresAt = convertDateToClickhouseDateTime(
      new Date(run.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    );

    const event: TaskEventV1Input = {
      environment_id: run.runtimeEnvironmentId,
      organization_id: run.organizationId,
      project_id: run.projectId,
      task_identifier: run.taskIdentifier,
      run_id: blockedRun.friendlyId,
      start_time: startTime.toString(),
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()).toString(),
      trace_id: blockedRun.traceId,
      span_id: spanId,
      parent_span_id: parentSpanId,
      message: run.taskIdentifier,
      kind: "SPAN",
      status: isError ? "ERROR" : "OK",
      attributes: {},
      metadata: "{}",
      expires_at: expiresAt,
    };

    this.addToBatch(event);
  }

  async completeFailedRunEvent({
    run,
    endTime,
    exception,
  }: {
    run: CompleteableTaskRun;
    endTime?: Date;
    exception: { message?: string; type?: string; stacktrace?: string };
  }): Promise<void> {
    if (!run.organizationId) {
      return;
    }

    const startTime = convertDateToNanoseconds(run.createdAt);
    const expiresAt = convertDateToClickhouseDateTime(
      new Date(run.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    );

    const event: TaskEventV1Input = {
      environment_id: run.runtimeEnvironmentId,
      organization_id: run.organizationId,
      project_id: run.projectId,
      task_identifier: run.taskIdentifier,
      run_id: run.friendlyId,
      start_time: startTime.toString(),
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()).toString(),
      trace_id: run.traceId,
      span_id: run.spanId,
      parent_span_id: run.parentSpanId ?? "",
      message: run.taskIdentifier,
      kind: "SPAN",
      status: "ERROR",
      attributes: {
        error: {
          name: exception.type,
          message: exception.message,
          stackTrace: exception.stacktrace,
        },
      },
      metadata: "{}",
      expires_at: expiresAt,
    };

    this.addToBatch(event);
  }

  async completeExpiredRunEvent({
    run,
    endTime,
    ttl,
  }: {
    run: CompleteableTaskRun;
    endTime?: Date;
    ttl: string;
  }): Promise<void> {
    if (!run.organizationId) {
      return;
    }

    const startTime = convertDateToNanoseconds(run.createdAt);
    const expiresAt = convertDateToClickhouseDateTime(
      new Date(run.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    );

    const event: TaskEventV1Input = {
      environment_id: run.runtimeEnvironmentId,
      organization_id: run.organizationId,
      project_id: run.projectId,
      task_identifier: run.taskIdentifier,
      run_id: run.friendlyId,
      start_time: startTime.toString(),
      duration: calculateDurationFromStart(startTime, endTime ?? new Date()).toString(),
      trace_id: run.traceId,
      span_id: run.spanId,
      parent_span_id: run.parentSpanId ?? "",
      message: run.taskIdentifier,
      kind: "SPAN",
      status: "ERROR",
      attributes: {
        error: {
          message: `Run expired because the TTL (${ttl}) was reached`,
        },
      },
      metadata: "{}",
      expires_at: expiresAt,
    };

    this.addToBatch(event);
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
  }): Promise<void> {
    if (!run.organizationId) {
      return;
    }

    const startTime = convertDateToNanoseconds(endTime ?? new Date());
    const expiresAt = convertDateToClickhouseDateTime(
      new Date(run.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    );

    const event: TaskEventV1Input = {
      environment_id: run.runtimeEnvironmentId,
      organization_id: run.organizationId,
      project_id: run.projectId,
      task_identifier: run.taskIdentifier,
      run_id: run.friendlyId,
      start_time: startTime.toString(),
      duration: "0",
      trace_id: run.traceId,
      span_id: run.spanId,
      parent_span_id: run.parentSpanId ?? "",
      message: "attempt_failed",
      kind: "ANCESTOR_OVERRIDE",
      status: "OK",
      attributes: {},
      metadata: JSON.stringify({
        exception,
        attemptNumber,
        runId: run.friendlyId,
      }),
      expires_at: expiresAt,
    };

    this.addToBatch(event);
  }

  async cancelRunEvent({
    reason,
    run,
    cancelledAt,
  }: {
    reason: string;
    run: CompleteableTaskRun;
    cancelledAt: Date;
  }): Promise<void> {
    if (!run.organizationId) {
      return;
    }

    const startTime = convertDateToNanoseconds(run.createdAt);
    const expiresAt = convertDateToClickhouseDateTime(
      new Date(run.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000)
    );

    const event: TaskEventV1Input = {
      environment_id: run.runtimeEnvironmentId,
      organization_id: run.organizationId,
      project_id: run.projectId,
      task_identifier: run.taskIdentifier,
      run_id: run.friendlyId,
      start_time: startTime.toString(),
      duration: calculateDurationFromStart(startTime, cancelledAt).toString(),
      trace_id: run.traceId,
      span_id: run.spanId,
      parent_span_id: run.parentSpanId ?? "",
      message: run.taskIdentifier,
      kind: "SPAN",
      status: "CANCELLED",
      attributes: {},
      metadata: JSON.stringify({
        reason,
      }),
      expires_at: expiresAt,
    };

    this.addToBatch(event);
  }

  // Query methods
  async getTraceSummary(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceSummary | undefined> {
    const startCreatedAtWithBuffer = new Date(startCreatedAt.getTime() - 1000);

    const queryBuilder = this._clickhouse.taskEvents.traceSummaryQueryBuilder();

    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("trace_id = {traceId: String}", { traceId });
    queryBuilder.where("start_time >= {startCreatedAt: String}", {
      startCreatedAt: convertDateToNanoseconds(startCreatedAtWithBuffer).toString(),
    });

    if (endCreatedAt) {
      queryBuilder.where("start_time <= {endCreatedAt: String}", {
        endCreatedAt: convertDateToNanoseconds(endCreatedAt).toString(),
      });
    }

    if (options?.includeDebugLogs === false) {
      queryBuilder.where("kind != {kind: String}", { kind: "DEBUG_EVENT" });
    }

    queryBuilder.orderBy("start_time ASC");

    if (this._config.maximumTraceSummaryViewCount) {
      queryBuilder.limit(this._config.maximumTraceSummaryViewCount);
    }

    const { query, params } = queryBuilder.build();

    logger.debug("ClickhouseEventRepository.getTraceSummary query", {
      query,
      params,
    });

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    if (!records) {
      return;
    }

    logger.info("ClickhouseEventRepository.getTraceSummary", {
      records,
    });

    const recordsGroupedBySpanId = records.reduce((acc, record) => {
      acc[record.span_id] = [...(acc[record.span_id] ?? []), record];
      return acc;
    }, {} as Record<string, TaskEventSummaryV1Result[]>);

    const spanSummaries = new Map<string, SpanSummary>();
    let rootSpanId: string | undefined;

    for (const [spanId, spanRecords] of Object.entries(recordsGroupedBySpanId)) {
      logger.debug("ClickhouseEventRepository.getTraceSummary recordsGroupedBySpanId", {
        spanId,
        spanRecords,
      });

      const spanSummary = this.#mergeRecordsIntoSpanSummary(spanId, spanRecords);

      if (!spanSummary) {
        continue;
      }

      logger.debug("ClickhouseEventRepository.getTraceSummary spanSummary", {
        spanSummary,
      });

      spanSummaries.set(spanId, spanSummary);

      if (!rootSpanId && !spanSummary.parentId) {
        rootSpanId = spanId;
      }
    }

    if (!rootSpanId) {
      logger.debug("ClickhouseEventRepository.getTraceSummary no rootSpanId", {
        spanSummaries,
      });

      return;
    }

    const spans = Array.from(spanSummaries.values());
    const rootSpan = spanSummaries.get(rootSpanId);

    if (!rootSpan) {
      logger.debug("ClickhouseEventRepository.getTraceSummary no rootSpan", {
        spanSummaries,
      });

      return;
    }

    const overridesBySpanId: Record<string, SpanOverride> = {};

    const finalSpans = spans.map((span) => {
      return this.#applyAncestorOverrides(span, spanSummaries, overridesBySpanId);
    });

    logger.info("ClickhouseEventRepository.getTraceSummary result", {
      rootSpan,
      spans: finalSpans,
    });

    return {
      rootSpan,
      spans: finalSpans,
      overridesBySpanId,
    };
  }

  async getSpan(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<SpanDetail | undefined> {
    const startCreatedAtWithBuffer = new Date(startCreatedAt.getTime() - 1000);

    const queryBuilder = this._clickhouse.taskEvents.spanDetailsQueryBuilder();

    queryBuilder.where("environment_id = {environmentId: String}", { environmentId });
    queryBuilder.where("trace_id = {traceId: String}", { traceId });
    queryBuilder.where("span_id = {spanId: String}", { spanId });
    queryBuilder.where("start_time >= {startCreatedAt: String}", {
      startCreatedAt: convertDateToNanoseconds(startCreatedAtWithBuffer).toString(),
    });

    if (endCreatedAt) {
      queryBuilder.where("start_time <= {endCreatedAt: String}", {
        endCreatedAt: convertDateToNanoseconds(endCreatedAt).toString(),
      });
    }

    queryBuilder.orderBy("start_time ASC");

    const { query, params } = queryBuilder.build();

    logger.debug("ClickhouseEventRepository.getSpan query", {
      query,
      params,
    });

    const [queryError, records] = await queryBuilder.execute();

    if (queryError) {
      throw queryError;
    }

    if (!records) {
      return;
    }

    const span = this.#mergeRecordsIntoSpanDetail(spanId, records);

    logger.info("ClickhouseEventRepository.getSpan", {
      span,
    });

    return span;
  }

  #mergeRecordsIntoSpanDetail(
    spanId: string,
    records: TaskEventDetailsV1Result[]
  ): SpanDetail | undefined {
    if (records.length === 0) {
      return undefined;
    }

    let span: SpanDetail | undefined;

    for (const record of records) {
      if (!span) {
        span = {
          spanId: spanId,
          parentId: record.parent_span_id ? record.parent_span_id : null,
          message: record.message,
          isError: false,
          isPartial: true, // Partial by default, can only be set to false
          isCancelled: false,
          level: kindToLevel(record.kind),
          startTime: convertClickhouseDateTime64ToJsDate(record.start_time),
          duration: typeof record.duration === "number" ? record.duration : Number(record.duration),
          events: [],
          style: {},
          properties: undefined,
          entity: {
            type: undefined,
            id: undefined,
          },
          metadata: {},
        };
      }

      if (isLogEvent(record.kind)) {
        span.isPartial = false;
        span.isCancelled = false;
        span.isError = record.status === "ERROR";
      }

      const parsedMetadata = this.#parseMetadata(record.metadata);

      if (record.kind === "SPAN_EVENT") {
        // We need to add an event to the span
        span.events.push({
          name: record.message,
          time: convertClickhouseDateTime64ToJsDate(record.start_time),
          properties: parsedMetadata ?? {},
        });
      }

      if (parsedMetadata && "style" in parsedMetadata && parsedMetadata.style) {
        span.style = parsedMetadata.style as TaskEventStyle;
      }

      if (
        parsedMetadata &&
        "entity" in parsedMetadata &&
        typeof parsedMetadata.entity === "object" &&
        parsedMetadata.entity
      ) {
        span.entity = parsedMetadata.entity as { type: string | undefined; id: string | undefined };
      }

      if (record.kind === "SPAN") {
        if (record.status === "ERROR") {
          span.isError = true;
          span.isPartial = false;
          span.isCancelled = false;
        } else if (record.status === "CANCELLED") {
          span.isCancelled = true;
          span.isPartial = false;
          span.isError = false;
        } else if (record.status === "OK") {
          span.isPartial = false;
        }

        if (record.status !== "PARTIAL") {
          span.duration =
            typeof record.duration === "number" ? record.duration : Number(record.duration);
        } else {
          span.startTime = convertClickhouseDateTime64ToJsDate(record.start_time);
          span.message = record.message;
        }
      }

      if (
        !span.properties &&
        record.attributes &&
        typeof record.attributes === "object" &&
        !isEmptyObject(record.attributes)
      ) {
        span.properties = record.attributes as Record<string, unknown>;
      }
    }

    return span;
  }

  #applyAncestorOverrides(
    span: SpanSummary,
    spansById: Map<string, SpanSummary>,
    overridesBySpanId: Record<string, SpanOverride>
  ): SpanSummary {
    if (span.data.level !== "TRACE") {
      return span;
    }

    if (!span.data.isPartial) {
      return span;
    }

    if (!span.parentId) {
      return span;
    }

    // Now we need to walk the ancestors of the span by span.parentId
    // The first ancestor that is a TRACE span that is "closed" we will use to override the span
    let parentSpanId: string | undefined = span.parentId;
    let overrideSpan: SpanSummary | undefined;

    while (parentSpanId) {
      const parentSpan = spansById.get(parentSpanId);

      if (!parentSpan) {
        break;
      }

      if (parentSpan.data.level === "TRACE" && !parentSpan.data.isPartial) {
        overrideSpan = parentSpan;
        break;
      }

      parentSpanId = parentSpan.parentId;
    }

    if (overrideSpan) {
      return this.#applyAncestorToSpan(span, overrideSpan, overridesBySpanId);
    }

    return span;
  }

  #applyAncestorToSpan(
    span: SpanSummary,
    overrideSpan: SpanSummary,
    overridesBySpanId: Record<string, SpanOverride>
  ): SpanSummary {
    if (overridesBySpanId[span.id]) {
      return span;
    }

    let override: SpanOverride | undefined = undefined;

    const overrideEndTime = calculateEndTimeFromStartTime(
      overrideSpan.data.startTime,
      overrideSpan.data.duration
    );

    if (overrideSpan.data.isCancelled) {
      override = {
        isCancelled: true,
        duration: calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime),
      };

      span.data.isCancelled = true;
      span.data.isPartial = false;
      span.data.isError = false;
      span.data.duration = calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime);

      const cancellationEvent = overrideSpan.data.events.find(
        (event) => event.name === "cancellation"
      );

      if (cancellationEvent) {
        span.data.events.push(cancellationEvent);
        override.events = [cancellationEvent];
      }
    }

    if (overrideSpan.data.isError && span.data.attemptNumber) {
      const attemptFailedEvent = overrideSpan.data.events.find(
        (event) =>
          event.name === "attempt_failed" &&
          event.properties.attemptNumber === span.data.attemptNumber &&
          event.properties.runId === span.runId
      ) as AttemptFailedSpanEvent | undefined;

      if (attemptFailedEvent) {
        const exceptionEvent = {
          name: "exception",
          time: attemptFailedEvent.time,
          properties: {
            exception: attemptFailedEvent.properties.exception,
          },
        } satisfies ExceptionSpanEvent;

        span.data.isError = true;
        span.data.isPartial = false;
        span.data.isCancelled = false;
        span.data.duration = calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime);
        span.data.events.push(exceptionEvent);
        span.data.events.push(attemptFailedEvent);

        override = {
          isError: true,
          events: [exceptionEvent],
          duration: calculateDurationFromStartJsDate(span.data.startTime, overrideEndTime),
        };
      }
    }

    if (override) {
      overridesBySpanId[span.id] = override;
    }

    return span;
  }

  #mergeRecordsIntoSpanSummary(
    spanId: string,
    records: TaskEventSummaryV1Result[]
  ): SpanSummary | undefined {
    if (records.length === 0) {
      return undefined;
    }

    let span: SpanSummary | undefined;

    for (const record of records) {
      if (!span) {
        span = {
          id: spanId,
          parentId: record.parent_span_id ? record.parent_span_id : undefined,
          runId: record.run_id,
          data: {
            message: record.message,
            style: {},
            duration:
              typeof record.duration === "number" ? record.duration : Number(record.duration),
            isError: false,
            isPartial: true, // Partial by default, can only be set to false
            isCancelled: false,
            isDebug: record.kind === "DEBUG_EVENT",
            startTime: convertClickhouseDateTime64ToJsDate(record.start_time),
            level: kindToLevel(record.kind),
            events: [],
          },
        };
      }

      if (isLogEvent(record.kind)) {
        span.data.isPartial = false;
        span.data.isCancelled = false;
        span.data.isError = record.status === "ERROR";
      }

      const parsedMetadata = this.#parseMetadata(record.metadata);

      if (
        parsedMetadata &&
        "attemptNumber" in parsedMetadata &&
        typeof parsedMetadata.attemptNumber === "number"
      ) {
        span.data.attemptNumber = parsedMetadata.attemptNumber;
      }

      if (record.kind === "ANCESTOR_OVERRIDE" || record.kind === "SPAN_EVENT") {
        // We need to add an event to the span
        span.data.events.push({
          name: record.message,
          time: convertClickhouseDateTime64ToJsDate(record.start_time),
          properties: parsedMetadata ?? {},
        });
      }

      if (parsedMetadata && "style" in parsedMetadata && parsedMetadata.style) {
        span.data.style = parsedMetadata.style as TaskEventStyle;
      }

      if (record.kind === "SPAN") {
        if (record.status === "ERROR") {
          span.data.isError = true;
          span.data.isPartial = false;
          span.data.isCancelled = false;
        } else if (record.status === "CANCELLED") {
          span.data.isCancelled = true;
          span.data.isPartial = false;
          span.data.isError = false;
        } else if (record.status === "OK") {
          span.data.isPartial = false;
        }

        if (record.status !== "PARTIAL") {
          span.data.duration =
            typeof record.duration === "number" ? record.duration : Number(record.duration);
        } else {
          span.data.startTime = convertClickhouseDateTime64ToJsDate(record.start_time);
          span.data.message = record.message;
        }
      }
    }

    return span;
  }

  #parseMetadata(metadata: string): Record<string, unknown> | undefined {
    if (!metadata) {
      return undefined;
    }

    const parsed = JSON.parse(metadata);

    if (typeof parsed !== "object" || parsed === null) {
      return undefined;
    }

    return parsed as Record<string, unknown>;
  }

  async getTraceDetailedSummary(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date,
    options?: { includeDebugLogs?: boolean }
  ): Promise<TraceDetailedSummary | undefined> {
    throw new Error("ClickhouseEventRepository.getTraceDetailedSummary not implemented");
  }

  async getRunEvents(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    runId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<RunPreparedEvent[]> {
    throw new Error("ClickhouseEventRepository.getRunEvents not implemented");
  }

  async getSpanOriginalRunId(
    storeTable: TaskEventStoreTable,
    environmentId: string,
    spanId: string,
    traceId: string,
    startCreatedAt: Date,
    endCreatedAt?: Date
  ): Promise<string | undefined> {
    return await originalRunIdCache.lookup(traceId, spanId);
  }
}

export const convertDateToClickhouseDateTime = (date: Date): string => {
  // 2024-11-06T20:37:00.123Z -> 2024-11-06 21:37:00.123
  return date.toISOString().replace("T", " ").replace("Z", "");
};

/**
 * Convert a ClickHouse DateTime64 to nanoseconds since epoch (UTC).
 * Accepts:
 *  - "2025-09-23 12:32:46.130262875"
 *  - "2025-09-23T12:32:46.13"
 *  - "2025-09-23 12:32:46Z"
 *  - "2025-09-23 12:32:46.130262875+02:00"
 */
export function convertClickhouseDateTime64ToNanosecondsEpoch(date: string): bigint {
  const s = date.trim();
  const re =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):?(\d{2}))?$/;

  const m = re.exec(s);
  if (!m) {
    throw new Error(`Invalid ClickHouse DateTime64 string: "${date}"`);
  }

  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]); // 1-31
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const fraction = m[7] ?? ""; // up to 9 digits
  const sign = m[8] as "+" | "-" | undefined;
  const offH = m[9] ? Number(m[9]) : 0;
  const offM = m[10] ? Number(m[10]) : 0;

  // Convert fractional seconds to exactly 9 digits (nanoseconds within the second).
  const nsWithinSecond = Number(fraction.padEnd(9, "0")); // 0..999_999_999

  // Split into millisecond part (for Date) and leftover nanoseconds.
  const msPart = Math.trunc(nsWithinSecond / 1_000_000); // 0..999
  const leftoverNs = nsWithinSecond - msPart * 1_000_000; // 0..999_999

  // Build milliseconds since epoch in UTC using Date.UTC (avoids local TZ/DST issues).
  let msEpoch = Date.UTC(year, month - 1, day, hour, minute, second, msPart);

  // If an explicit offset was provided, adjust to true UTC.
  if (sign) {
    const offsetMinutesSigned = (sign === "+" ? 1 : -1) * (offH * 60 + offM);
    msEpoch -= offsetMinutesSigned * 60_000;
  }

  // Combine ms to ns with leftover.
  return BigInt(msEpoch) * 1_000_000n + BigInt(leftoverNs);
}

/**
 * Convert a ClickHouse DateTime64 to a JS Date.
 * Accepts:
 *  - "2025-09-23 12:32:46.130262875"
 *  - "2025-09-23T12:32:46.13"
 *  - "2025-09-23 12:32:46Z"
 *  - "2025-09-23 12:32:46.130262875+02:00"
 */
export function convertClickhouseDateTime64ToJsDate(date: string): Date {
  const s = date.trim();
  const re =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:Z|([+-])(\d{2}):?(\d{2}))?$/;

  const m = re.exec(s);
  if (!m) {
    throw new Error(`Invalid ClickHouse DateTime64 string: "${date}"`);
  }

  const year = Number(m[1]);
  const month = Number(m[2]); // 1-12
  const day = Number(m[3]); // 1-31
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6]);
  const fraction = m[7] ?? ""; // up to 9 digits

  // Convert fractional seconds to exactly 9 digits (nanoseconds within the second).
  const nsWithinSecond = Number(fraction.padEnd(9, "0")); // 0..999_999_999

  // Split into millisecond part (for Date)
  const msPart = Math.trunc(nsWithinSecond / 1_000_000); // 0..999

  return new Date(Date.UTC(year, month - 1, day, hour, minute, second, msPart));
}

function kindToLevel(kind: string): TaskEventLevel {
  switch (kind) {
    case "DEBUG_EVENT":
    case "LOG_DEBUG": {
      return "DEBUG";
    }
    case "LOG_LOG": {
      return "LOG";
    }
    case "LOG_INFO": {
      return "INFO";
    }
    case "LOG_WARN": {
      return "WARN";
    }
    case "LOG_ERROR": {
      return "ERROR";
    }
    case "SPAN":
    case "ANCESTOR_OVERRIDE":
    case "SPAN_EVENT": {
      return "TRACE";
    }
    default: {
      return "TRACE";
    }
  }
}

function isLogEvent(kind: string): boolean {
  return kind.startsWith("LOG_") || kind === "DEBUG_EVENT";
}

function calculateEndTimeFromStartTime(startTime: Date, duration: number): Date {
  return new Date(startTime.getTime() + duration / 1_000_000);
}
