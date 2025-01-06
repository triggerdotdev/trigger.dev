import { Attributes, AttributeValue, Link, TraceFlags } from "@opentelemetry/api";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
  ExceptionEventProperties,
  ExceptionSpanEvent,
  NULL_SENTINEL,
  PRIMARY_VARIANT,
  SemanticInternalAttributes,
  SpanEvent,
  SpanEvents,
  SpanMessagingEvent,
  TaskEventStyle,
  TaskRunError,
  correctErrorStackTrace,
  createPacketAttributesAsJson,
  flattenAttributes,
  isExceptionSpanEvent,
  omit,
  unflattenAttributes,
} from "@trigger.dev/core/v3";
import { Prisma, TaskEvent, TaskEventStatus, type TaskEventKind } from "@trigger.dev/database";
import Redis, { RedisOptions } from "ioredis";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:stream";
import { Gauge } from "prom-client";
import { $replica, PrismaClient, PrismaReplicaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { metricsRegister } from "~/metrics.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import { DynamicFlushScheduler } from "./dynamicFlushScheduler.server";
import { startActiveSpan } from "./tracer.server";

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
  context?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "trigger" | "replay";
  spanIdSeed?: string;
  attributes: TraceAttributes;
  environment: AuthenticatedEnvironment;
  taskSlug: string;
  startTime?: bigint;
  endTime?: Date;
  immediate?: boolean;
};

export type EventBuilder = {
  traceId: string;
  spanId: string;
  setAttribute: SetAttribute<TraceAttributes>;
};

export type EventRepoConfig = {
  batchSize: number;
  batchInterval: number;
  redis: RedisOptions;
  retentionInDays: number;
};

export type QueryOptions = Prisma.TaskEventWhereInput;

export type TaskEventRecord = TaskEvent;

export type QueriedEvent = Prisma.TaskEventGetPayload<{
  select: {
    id: true;
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
    isDebug: true;
    level: true;
    events: true;
    environmentType: true;
  };
}>;

export type PreparedEvent = Omit<QueriedEvent, "events" | "style" | "duration"> & {
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
  recordId: string;
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

export type UpdateEventOptions = {
  attributes: TraceAttributes;
  endTime?: Date;
  immediate?: boolean;
  events?: SpanEvents;
};

export class EventRepository {
  private readonly _flushScheduler: DynamicFlushScheduler<CreatableEvent>;
  private _randomIdGenerator = new RandomIdGenerator();
  private _redisPublishClient: Redis;
  private _subscriberCount = 0;

  get subscriberCount() {
    return this._subscriberCount;
  }

  constructor(
    private db: PrismaClient = prisma,
    private readReplica: PrismaReplicaClient = $replica,
    private readonly _config: EventRepoConfig
  ) {
    this._flushScheduler = new DynamicFlushScheduler({
      batchSize: _config.batchSize,
      flushInterval: _config.batchInterval,
      callback: this.#flushBatch.bind(this),
    });

    this._redisPublishClient = new Redis(this._config.redis);
  }

  async insert(event: CreatableEvent) {
    this._flushScheduler.addToBatch([event]);
  }

  async insertImmediate(event: CreatableEvent) {
    await this.#flushBatch([event]);
  }

  async insertMany(events: CreatableEvent[]) {
    this._flushScheduler.addToBatch(events);
  }

  async insertManyImmediate(events: CreatableEvent[]) {
    return await this.#flushBatch(events);
  }

  async completeEvent(spanId: string, options?: UpdateEventOptions) {
    const events = await this.queryIncompleteEvents({ spanId });

    if (events.length === 0) {
      logger.warn("No incomplete events found for spanId", { spanId, options });
      return;
    }

    const event = events[0];

    const output = options?.attributes.output
      ? await createPacketAttributesAsJson(
          options?.attributes.output,
          options?.attributes.outputType ?? "application/json"
        )
      : undefined;

    logger.debug("Completing event", {
      spanId,
      eventId: event.id,
    });

    const completedEvent = {
      ...omit(event, "id"),
      isPartial: false,
      isError: options?.attributes.isError ?? false,
      isCancelled: false,
      status: options?.attributes.isError ? "ERROR" : "OK",
      links: event.links ?? [],
      events: event.events ?? (options?.events as any) ?? [],
      duration: calculateDurationFromStart(event.startTime, options?.endTime),
      properties: event.properties as Attributes,
      metadata: event.metadata as Attributes,
      style: event.style as Attributes,
      output: output,
      outputType:
        options?.attributes.outputType === "application/store" ||
        options?.attributes.outputType === "text/plain"
          ? options?.attributes.outputType
          : "application/json",
      payload: event.payload as Attributes,
      payloadType: event.payloadType,
    } satisfies CreatableEvent;

    await this.insert(completedEvent);

    return completedEvent;
  }

  async cancelEvent(event: TaskEventRecord, cancelledAt: Date, reason: string) {
    if (!event.isPartial) {
      return;
    }

    await this.insertImmediate({
      ...omit(event, "id"),
      isPartial: false,
      isError: false,
      isCancelled: true,
      status: "ERROR",
      links: event.links ?? [],
      events: [
        {
          name: "cancellation",
          time: cancelledAt,
          properties: {
            reason,
          },
        },
        ...((event.events as any[]) ?? []),
      ],
      duration: calculateDurationFromStart(event.startTime, cancelledAt),
      properties: event.properties as Attributes,
      metadata: event.metadata as Attributes,
      style: event.style as Attributes,
      output: event.output as Attributes,
      outputType: event.outputType,
      payload: event.payload as Attributes,
      payloadType: event.payloadType,
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

  async queryEvents(queryOptions: QueryOptions): Promise<TaskEventRecord[]> {
    return await this.readReplica.taskEvent.findMany({
      where: queryOptions,
    });
  }

  async queryIncompleteEvents(queryOptions: QueryOptions, allowCompleteDuplicate = false) {
    // First we will find all the events that match the query options (selecting minimal data).
    const taskEvents = await this.readReplica.taskEvent.findMany({
      where: queryOptions,
      select: {
        spanId: true,
        isPartial: true,
        isCancelled: true,
      },
    });

    const filteredTaskEvents = taskEvents.filter((event) => {
      // Event must be partial
      if (!event.isPartial) return false;

      // If the event is cancelled, it is not incomplete
      if (event.isCancelled) return false;

      if (allowCompleteDuplicate) {
        return true;
      }

      // There must not be another complete event with the same spanId
      const hasCompleteDuplicate = taskEvents.some(
        (otherEvent) =>
          otherEvent.spanId === event.spanId && !otherEvent.isPartial && !otherEvent.isCancelled
      );

      return !hasCompleteDuplicate;
    });

    return this.queryEvents({
      spanId: {
        in: filteredTaskEvents.map((event) => event.spanId),
      },
    });
  }

  public async getTraceSummary(traceId: string): Promise<TraceSummary | undefined> {
    return await startActiveSpan("getTraceSummary", async (span) => {
      const events = await this.readReplica.taskEvent.findMany({
        select: {
          id: true,
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
          isDebug: true,
          level: true,
          events: true,
          environmentType: true,
        },
        where: {
          traceId,
        },
        orderBy: {
          startTime: "asc",
        },
        take: env.MAXIMUM_TRACE_SUMMARY_VIEW_COUNT,
      });

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

        if (event.isCancelled || !event.isPartial) {
          eventsBySpanId.set(event.spanId, event);
        }
      }

      preparedEvents = Array.from(eventsBySpanId.values());

      const spansBySpanId = new Map<string, SpanSummary>();

      const spans = preparedEvents.map((event) => {
        const ancestorCancelled = isAncestorCancelled(eventsBySpanId, event.spanId);
        const duration = calculateDurationIfAncestorIsCancelled(
          eventsBySpanId,
          event.spanId,
          event.duration
        );

        const span = {
          recordId: event.id,
          id: event.spanId,
          parentId: event.parentId ?? undefined,
          runId: event.runId,
          idempotencyKey: event.idempotencyKey,
          data: {
            message: event.message,
            style: event.style,
            duration,
            isError: event.isError,
            isPartial: ancestorCancelled ? false : event.isPartial,
            isCancelled: event.isCancelled === true ? true : event.isPartial && ancestorCancelled,
            isDebug: event.isDebug,
            startTime: getDateFromNanoseconds(event.startTime),
            level: event.level,
            events: event.events,
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

  public async getRunEvents(runId: string): Promise<RunPreparedEvent[]> {
    return await startActiveSpan("getRunEvents", async (span) => {
      const events = await this.readReplica.taskEvent.findMany({
        select: {
          id: true,
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
          isDebug: true,
          level: true,
          events: true,
          environmentType: true,
          taskSlug: true,
        },
        where: {
          runId,
          isPartial: false,
        },
        orderBy: {
          startTime: "asc",
        },
      });

      let preparedEvents: Array<PreparedEvent> = [];

      for (const event of events) {
        preparedEvents.push(prepareEvent(event));
      }

      return preparedEvents;
    });
  }

  // A Span can be cancelled if it is partial and has a parent that is cancelled
  // And a span's duration, if it is partial and has a cancelled parent, is the time between the start of the span and the time of the cancellation event of the parent
  public async getSpan(spanId: string, traceId: string) {
    return await startActiveSpan("getSpan", async (s) => {
      const spanEvent = await this.#getSpanEvent(spanId);

      if (!spanEvent) {
        return;
      }

      const preparedEvent = prepareEvent(spanEvent);

      const span = await this.#createSpanFromEvent(preparedEvent);

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
        preparedEvent.events,
        spanEvent.metadata as Attributes,
        spanEvent.environmentType === "DEVELOPMENT"
      );

      const originalRun = rehydrateAttribute<string>(
        spanEvent.properties,
        SemanticInternalAttributes.ORIGINAL_RUN_ID
      );

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
      };
    });
  }

  async #createSpanFromEvent(event: PreparedEvent) {
    return await startActiveSpan("createSpanFromEvent", async (s) => {
      let ancestorCancelled = false;
      let duration = event.duration;

      if (!event.isCancelled && event.isPartial) {
        await this.#walkSpanAncestors(event, (ancestorEvent, level) => {
          if (level >= 8) {
            return { stop: true };
          }

          if (ancestorEvent.isCancelled) {
            ancestorCancelled = true;

            // We need to get the cancellation time from the cancellation span event
            const cancellationEvent = ancestorEvent.events.find(
              (event) => event.name === "cancellation"
            );

            if (cancellationEvent) {
              duration = calculateDurationFromStart(event.startTime, cancellationEvent.time);
            }

            return { stop: true };
          }

          return { stop: false };
        });
      }

      const span = {
        recordId: event.id,
        id: event.spanId,
        parentId: event.parentId ?? undefined,
        runId: event.runId,
        idempotencyKey: event.idempotencyKey,
        data: {
          message: event.message,
          style: event.style,
          duration,
          isError: event.isError,
          isPartial: ancestorCancelled ? false : event.isPartial,
          isCancelled: event.isCancelled === true ? true : event.isPartial && ancestorCancelled,
          startTime: getDateFromNanoseconds(event.startTime),
          level: event.level,
          events: event.events,
          environmentType: event.environmentType,
        },
      };

      return span;
    });
  }

  async #walkSpanAncestors(
    event: PreparedEvent,
    callback: (event: PreparedEvent, level: number) => { stop: boolean }
  ) {
    const parentId = event.parentId;
    if (!parentId) {
      return;
    }

    await startActiveSpan("walkSpanAncestors", async (s) => {
      let parentEvent = await this.#getSpanEvent(parentId);
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

        parentEvent = await this.#getSpanEvent(preparedParentEvent.parentId);

        level++;
      }
    });
  }

  async #getSpanAncestors(event: PreparedEvent, levels = 1): Promise<Array<PreparedEvent>> {
    if (levels >= 8) {
      return [];
    }

    if (!event.parentId) {
      return [];
    }

    const parentEvent = await this.#getSpanEvent(event.parentId);

    if (!parentEvent) {
      return [];
    }

    const preparedParentEvent = prepareEvent(parentEvent);

    if (!preparedParentEvent.parentId) {
      return [preparedParentEvent];
    }

    const moreAncestors = await this.#getSpanAncestors(preparedParentEvent, levels + 1);

    return [preparedParentEvent, ...moreAncestors];
  }

  async #getSpanEvent(spanId: string) {
    return await startActiveSpan("getSpanEvent", async (s) => {
      const events = await this.readReplica.taskEvent.findMany({
        where: {
          spanId,
        },
        orderBy: {
          startTime: "asc",
        },
      });

      let finalEvent: TaskEvent | undefined;

      for (const event of events) {
        if (event.isPartial && finalEvent) {
          continue;
        }

        finalEvent = event;
      }

      return finalEvent;
    });
  }

  public async recordEvent(message: string, options: TraceEventOptions & { duration?: number }) {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const startTime = options.startTime ?? getNowInNanoseconds();
    const duration =
      options.duration ??
      (options.endTime ? calculateDurationFromStart(startTime, options.endTime) : 100);

    const traceId = propagatedContext?.traceparent?.traceId ?? this.generateTraceId();
    const parentId = propagatedContext?.traceparent?.spanId;
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

    const isDebug = options.attributes.isDebug;

    const style = {
      [SemanticInternalAttributes.STYLE_ICON]: isDebug ? "warn" : "play",
    };

    if (!options.attributes.runId) {
      throw new Error("runId is required");
    }

    const event: CreatableEvent = {
      traceId,
      spanId,
      parentId,
      tracestate,
      message: message,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: isDebug ? "WARN" : "TRACE",
      kind: options.kind,
      status: "OK",
      startTime,
      isPartial: false,
      isDebug,
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
    options: TraceEventOptions & { incomplete?: boolean },
    callback: (
      e: EventBuilder,
      traceContext: Record<string, string | undefined>,
      traceparent?: { traceId: string; spanId: string }
    ) => Promise<TResult>
  ): Promise<TResult> {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const start = process.hrtime.bigint();
    const startTime = getNowInNanoseconds();

    const traceId = options.spanParentAsLink
      ? this.generateTraceId()
      : propagatedContext?.traceparent?.traceId ?? this.generateTraceId();
    const parentId = options.spanParentAsLink ? undefined : propagatedContext?.traceparent?.spanId;
    const tracestate = options.spanParentAsLink ? undefined : propagatedContext?.tracestate;
    const spanId = options.spanIdSeed
      ? this.#generateDeterministicSpanId(traceId, options.spanIdSeed)
      : this.generateSpanId();

    const traceContext = {
      traceparent: `00-${traceId}-${spanId}-01`,
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
    };

    const result = await callback(eventBuilder, traceContext, propagatedContext?.traceparent);

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
      tracestate,
      duration: options.incomplete ? 0 : duration,
      isPartial: options.incomplete,
      message: message,
      serviceName: "api server",
      serviceNamespace: "trigger.dev",
      level: "TRACE",
      kind: options.kind,
      status: "OK",
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
    };

    if (options.immediate) {
      await this.insertImmediate(event);
    } else {
      this._flushScheduler.addToBatch([event]);
    }

    return result;
  }

  async subscribeToTrace(traceId: string) {
    const redis = new Redis(this._config.redis);

    const channel = `events:${traceId}:*`;

    // Subscribe to the channel.
    await redis.psubscribe(channel);

    // Increment the subscriber count.
    this._subscriberCount++;

    const eventEmitter = new EventEmitter();

    // Define the message handler.
    redis.on("pmessage", (pattern, channelReceived, message) => {
      if (channelReceived.startsWith(`events:${traceId}:`)) {
        eventEmitter.emit("message", message);
      }
    });

    // Return a function that can be used to unsubscribe.
    const unsubscribe = async () => {
      await redis.punsubscribe(channel);
      redis.quit();
      this._subscriberCount--;
    };

    return {
      unsubscribe,
      eventEmitter,
    };
  }

  async #flushBatch(batch: CreatableEvent[]) {
    const events = excludePartialEventsWithCorrespondingFullEvent(batch);

    const flushedEvents = await this.#doFlushBatch(events);

    if (flushedEvents.length !== events.length) {
      logger.debug("[EventRepository][flushBatch] Failed to insert all events", {
        attemptCount: events.length,
        successCount: flushedEvents.length,
      });
    }

    this.#publishToRedis(flushedEvents);
  }

  async #doFlushBatch(events: CreatableEvent[], depth: number = 1): Promise<CreatableEvent[]> {
    try {
      await this.db.taskEvent.createMany({
        data: events as Prisma.TaskEventCreateManyInput[],
      });

      return events;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientUnknownRequestError) {
        logger.error("Failed to insert events, most likely because of null characters", {
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack,
            clientVersion: error.clientVersion,
          },
        });

        if (events.length === 1) {
          logger.debug("Attempting to insert event individually and it failed", {
            event: events[0],
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack,
              clientVersion: error.clientVersion,
            },
          });

          return [];
        }

        if (depth > MAX_FLUSH_DEPTH) {
          logger.error("Failed to insert events, reached maximum depth", {
            error: {
              name: error.name,
              message: error.message,
              stack: error.stack,
              clientVersion: error.clientVersion,
            },
            depth,
            eventsCount: events.length,
          });

          return [];
        }

        // Split the events into two batches, and recursively try to insert them.
        const middle = Math.floor(events.length / 2);
        const [firstHalf, secondHalf] = [events.slice(0, middle), events.slice(middle)];

        const [firstHalfEvents, secondHalfEvents] = await Promise.all([
          this.#doFlushBatch(firstHalf, depth + 1),
          this.#doFlushBatch(secondHalf, depth + 1),
        ]);

        return firstHalfEvents.concat(secondHalfEvents);
      }

      throw error;
    }
  }

  async #publishToRedis(events: CreatableEvent[]) {
    if (events.length === 0) return;
    const uniqueTraceSpans = new Set(events.map((e) => `events:${e.traceId}:${e.spanId}`));
    for (const id of uniqueTraceSpans) {
      await this._redisPublishClient.publish(id, new Date().toISOString());
    }
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
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
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

export function extractContextFromCarrier(carrier: Record<string, string | undefined>) {
  const traceparent = carrier["traceparent"];
  const tracestate = carrier["tracestate"];

  return {
    traceparent: parseTraceparent(traceparent),
    tracestate,
  };
}

function parseTraceparent(traceparent?: string): { traceId: string; spanId: string } | undefined {
  if (!traceparent) {
    return undefined;
  }

  const parts = traceparent.split("-");

  if (parts.length !== 4) {
    return undefined;
  }

  const [version, traceId, spanId, flags] = parts;

  if (version !== "00") {
    return undefined;
  }

  return { traceId, spanId };
}

function prepareEvent(event: QueriedEvent): PreparedEvent {
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

function isAncestorCancelled(events: Map<string, PreparedEvent>, spanId: string) {
  const event = events.get(spanId);

  if (!event) {
    return false;
  }

  if (event.isCancelled) {
    return true;
  }

  if (event.parentId) {
    return isAncestorCancelled(events, event.parentId);
  }

  return false;
}

function calculateDurationIfAncestorIsCancelled(
  events: Map<string, PreparedEvent>,
  spanId: string,
  defaultDuration: number
) {
  const event = events.get(spanId);

  if (!event) {
    return defaultDuration;
  }

  if (event.isCancelled) {
    return defaultDuration;
  }

  if (!event.isPartial) {
    return defaultDuration;
  }

  if (event.parentId) {
    const cancelledAncestor = findFirstCancelledAncestor(events, event.parentId);

    if (cancelledAncestor) {
      // We need to get the cancellation time from the cancellation span event
      const cancellationEvent = cancelledAncestor.events.find(
        (event) => event.name === "cancellation"
      );

      if (cancellationEvent) {
        return calculateDurationFromStart(event.startTime, cancellationEvent.time);
      }
    }
  }

  return defaultDuration;
}

function findFirstCancelledAncestor(events: Map<string, PreparedEvent>, spanId: string) {
  const event = events.get(spanId);

  if (!event) {
    return;
  }

  if (event.isCancelled) {
    return event;
  }

  if (event.parentId) {
    return findFirstCancelledAncestor(events, event.parentId);
  }

  return;
}

// Prioritize spans with the same id, keeping the completed spans over partial spans
// Completed spans are either !isPartial or isCancelled
function removeDuplicateEvents(events: PreparedEvent[]) {
  const dedupedEvents = new Map<string, PreparedEvent>();

  for (const event of events) {
    const existingEvent = dedupedEvents.get(event.spanId);

    if (!existingEvent) {
      dedupedEvents.set(event.spanId, event);
      continue;
    }

    if (event.isCancelled || !event.isPartial) {
      dedupedEvents.set(event.spanId, event);
    }
  }

  return Array.from(dedupedEvents.values());
}

function isEmptyJson(json: Prisma.JsonValue) {
  if (json === null) {
    return true;
  }

  return false;
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

function filteredAttributes(attributes: Attributes, prefix: string): Attributes {
  const result: Attributes = {};

  for (const [key, value] of Object.entries(attributes)) {
    if (key.startsWith(prefix)) {
      result[key] = value;
    }
  }

  return result;
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

function rehydrateAttribute<T extends AttributeValue>(
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

  if (!value) return;

  return value as T;
}
