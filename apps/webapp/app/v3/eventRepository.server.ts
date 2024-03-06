import { Attributes, Link, TraceFlags } from "@opentelemetry/api";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import {
  ExceptionEventProperties,
  PRIMARY_VARIANT,
  SemanticInternalAttributes,
  SpanEvent,
  SpanEvents,
  TaskEventStyle,
  correctErrorStackTrace,
  flattenAndNormalizeAttributes,
  flattenAttributes,
  isExceptionSpanEvent,
  omit,
  unflattenAttributes,
} from "@trigger.dev/core/v3";
import { Prisma, TaskEvent, TaskEventStatus, type TaskEventKind } from "@trigger.dev/database";
import { createHash } from "node:crypto";
import { PrismaClient, prisma } from "~/db.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { DynamicFlushScheduler } from "./dynamicFlushScheduler.server";
import Redis, { RedisOptions } from "ioredis";
import { env } from "~/env.server";
import { EventEmitter } from "node:stream";
import { logger } from "~/services/logger.server";

export type CreatableEvent = Omit<
  Prisma.TaskEventCreateInput,
  "id" | "createdAt" | "properties" | "metadata" | "style" | "output"
> & {
  properties: Attributes;
  metadata: Attributes | undefined;
  style: Attributes | undefined;
  output: Attributes | string | boolean | number | undefined;
};

export type CreatableEventKind = TaskEventKind;
export type CreatableEventStatus = TaskEventStatus;
export type CreatableEventEnvironmentType = CreatableEvent["environmentType"];

export type TraceAttributes = Partial<
  Pick<
    CreatableEvent,
    | "attemptId"
    | "isError"
    | "runId"
    | "runIsTest"
    | "output"
    | "metadata"
    | "properties"
    | "style"
    | "queueId"
    | "queueName"
    | "batchId"
  >
>;

export type SetAttribute<T extends TraceAttributes> = (key: keyof T, value: T[keyof T]) => void;

export type TraceEventOptions = {
  kind?: CreatableEventKind;
  context?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  spanIdSeed?: string;
  attributes: TraceAttributes;
  environment: AuthenticatedEnvironment;
  taskSlug: string;
  startTime?: Date;
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
};

export type QueryOptions = Prisma.TaskEventWhereInput;

export type TaskEventRecord = TaskEvent;

export type QueriedEvent = TaskEvent;

export type PreparedEvent = Omit<TaskEventRecord, "events" | "style" | "duration"> & {
  duration: number;
  events: SpanEvents;
  style: TaskEventStyle;
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
    level: NonNullable<CreatableEvent["level"]>;
  };
};

export type TraceSummary = { rootSpan: SpanSummary; spans: Array<SpanSummary> };

export type UpdateEventOptions = {
  attributes: TraceAttributes;
  endTime?: Date;
  immediate?: boolean;
};

export class EventRepository {
  private readonly _flushScheduler: DynamicFlushScheduler<CreatableEvent>;
  private _randomIdGenerator = new RandomIdGenerator();
  private _redisPublishClient: Redis;

  constructor(private db: PrismaClient = prisma, private readonly _config: EventRepoConfig) {
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
    await this.db.taskEvent.create({
      data: event as Prisma.TaskEventCreateInput,
    });

    this.#publishToRedis([event]);
  }

  async insertMany(events: CreatableEvent[]) {
    this._flushScheduler.addToBatch(events);
  }

  async completeEvent(spanId: string, options?: UpdateEventOptions) {
    const events = await this.queryIncompleteEvents({ spanId });

    if (events.length === 0) {
      return;
    }

    const event = events[0];

    logger.debug("Completing event", { spanId, eventId: event.id });

    await this.insert({
      ...omit(event, "id"),
      isPartial: false,
      isError: options?.attributes.isError ?? false,
      isCancelled: false,
      status: options?.attributes.isError ? "ERROR" : "OK",
      links: event.links ?? [],
      events: event.events ?? [],
      duration:
        ((options?.endTime ?? new Date()).getTime() - event.startTime.getTime()) * 1_000_000, // convert to nanoseconds
      properties: event.properties as Attributes,
      metadata: event.metadata as Attributes,
      style: event.style as Attributes,
      output: options?.attributes.output
        ? flattenAndNormalizeAttributes(
            options.attributes.output,
            SemanticInternalAttributes.OUTPUT
          )
        : undefined,
    });
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
      duration: (cancelledAt.getTime() - event.startTime.getTime()) * 1_000_000, // convert to nanoseconds
      properties: event.properties as Attributes,
      metadata: event.metadata as Attributes,
      style: event.style as Attributes,
      output: event.output as Attributes,
    });
  }

  async queryEvents(queryOptions: QueryOptions): Promise<TaskEventRecord[]> {
    return await this.db.taskEvent.findMany({
      where: queryOptions,
    });
  }

  async queryIncompleteEvents(queryOptions: QueryOptions) {
    // First we will find all the events that match the query options (selecting minimal data).
    const taskEvents = await this.db.taskEvent.findMany({
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
    const events = await this.db.taskEvent.findMany({
      where: {
        traceId,
      },
      orderBy: {
        startTime: "asc",
      },
    });

    const preparedEvents = removeDuplicateEvents(events.map(prepareEvent));

    const spans = preparedEvents.map((event) => {
      const ancestorCancelled = isAncestorCancelled(preparedEvents, event.spanId);
      const duration = calculateDurationIfAncestorIsCancelled(
        preparedEvents,
        event.spanId,
        event.duration
      );

      return {
        recordId: event.id,
        id: event.spanId,
        parentId: event.parentId ?? undefined,
        runId: event.runId,
        data: {
          message: event.message,
          style: event.style,
          duration,
          isError: event.isError,
          isPartial: ancestorCancelled ? false : event.isPartial,
          isCancelled: event.isCancelled === true ? true : event.isPartial && ancestorCancelled,
          startTime: event.startTime,
          level: event.level,
          events: event.events,
        },
      };
    });

    const rootSpanId = events.find((event) => !event.parentId);
    if (!rootSpanId) {
      return;
    }

    const rootSpan = spans.find((span) => span.id === rootSpanId.spanId);

    if (!rootSpan) {
      return;
    }

    return {
      rootSpan,
      spans,
    };
  }

  // A Span can be cancelled if it is partial and has a parent that is cancelled
  // And a span's duration, if it is partial and has a cancelled parent, is the time between the start of the span and the time of the cancellation event of the parent
  public async getSpan(spanId: string) {
    const traceSearch = await this.db.taskEvent.findFirst({
      where: {
        spanId,
      },
      select: {
        traceId: true,
      },
    });

    if (!traceSearch) {
      return;
    }

    const traceSummary = await this.getTraceSummary(traceSearch.traceId);

    const span = traceSummary?.spans.find((span) => span.id === spanId);

    if (!span) {
      return;
    }

    const fullEvent = await this.db.taskEvent.findUnique({
      where: {
        id: span.recordId,
      },
    });

    if (!fullEvent) {
      return;
    }

    const payload = unflattenAttributes(
      filteredAttributes(fullEvent.properties as Attributes, SemanticInternalAttributes.PAYLOAD)
    )[SemanticInternalAttributes.PAYLOAD];

    const output = isEmptyJson(fullEvent.output)
      ? null
      : unflattenAttributes(fullEvent.output as Attributes);

    const properties = sanitizedAttributes(fullEvent.properties);

    const events = transformEvents(span.data.events, fullEvent.metadata as Attributes);

    return {
      ...fullEvent,
      ...span.data,
      payload,
      output,
      properties,
      events,
    };
  }

  public async recordEvent(message: string, options: TraceEventOptions) {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const startTime = options.startTime ?? new Date();
    const durationInMs = options.endTime ? options.endTime.getTime() - startTime.getTime() : 100;

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

    const style = {
      [SemanticInternalAttributes.STYLE_ICON]: "play",
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
      level: "TRACE",
      kind: options.kind,
      status: "OK",
      startTime,
      isPartial: false,
      duration: durationInMs * 1_000_000, // convert to nanoseconds
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
      traceContext: Record<string, string | undefined>
    ) => Promise<TResult>
  ): Promise<TResult> {
    const propagatedContext = extractContextFromCarrier(options.context ?? {});

    const start = process.hrtime.bigint();
    const startTime = new Date();

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

    const result = await callback(eventBuilder, traceContext);

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
      startTime: startTime,
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
        ...flattenAttributes(options.attributes.properties),
      },
      metadata: metadata,
      style: stripAttributePrefix(style, SemanticInternalAttributes.STYLE),
      output: undefined,
      links: links as unknown as Prisma.InputJsonValue,
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
    };

    return {
      unsubscribe,
      eventEmitter,
    };
  }

  async #flushBatch(batch: CreatableEvent[]) {
    const events = excludePartialEventsWithCorrespondingFullEvent(batch);

    await this.db.taskEvent.createMany({
      data: events as Prisma.TaskEventCreateManyInput[],
    });

    this.#publishToRedis(events);
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

export const eventRepository = new EventRepository(prisma, {
  batchSize: 100,
  batchInterval: 5000,
  redis: {
    port: env.REDIS_PORT,
    host: env.REDIS_HOST,
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
    enableAutoPipelining: true,
    ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  },
});

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

function extractContextFromCarrier(carrier: Record<string, string | undefined>) {
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
  const eventsUnflattened = events
    ? (events as any[]).map((e) => ({
        ...e,
        properties: unflattenAttributes(e.properties as Attributes),
      }))
    : undefined;

  const spanEvents = SpanEvents.safeParse(eventsUnflattened);

  if (spanEvents.success) {
    return spanEvents.data;
  }

  return [];
}

function parseStyleField(style: Prisma.JsonValue): TaskEventStyle {
  const parsedStyle = TaskEventStyle.safeParse(unflattenAttributes(style as Attributes));

  if (parsedStyle.success) {
    return parsedStyle.data;
  }

  return {};
}

function isAncestorCancelled(events: PreparedEvent[], spanId: string) {
  const event = events.find((event) => event.spanId === spanId);

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
  events: PreparedEvent[],
  spanId: string,
  defaultDuration: number
) {
  const event = events.find((event) => event.spanId === spanId);

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
        return (cancellationEvent.time.getTime() - event.startTime.getTime()) * 1_000_000;
      }
    }
  }

  return defaultDuration;
}

function findFirstCancelledAncestor(events: PreparedEvent[], spanId: string) {
  const event = events.find((event) => event.spanId === spanId);
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
  if (Object.keys(json).length === 0) {
    return true;
  }

  return false;
}

function sanitizedAttributes(json: Prisma.JsonValue): Record<string, unknown> | undefined {
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

function transformEvents(events: SpanEvents, properties: Attributes): SpanEvents {
  return (events ?? []).map((event) => transformEvent(event, properties));
}

function transformEvent(event: SpanEvent, properties: Attributes): SpanEvent {
  if (isExceptionSpanEvent(event)) {
    return {
      ...event,
      properties: {
        exception: transformException(event.properties.exception, properties),
      },
    };
  }

  return event;
}

function transformException(
  exception: ExceptionEventProperties,
  properties: Attributes
): ExceptionEventProperties {
  const projectDirAttributeValue = properties[SemanticInternalAttributes.PROJECT_DIR];

  if (typeof projectDirAttributeValue !== "string") {
    return exception;
  }

  return {
    ...exception,
    stacktrace: exception.stacktrace
      ? correctErrorStackTrace(exception.stacktrace, projectDirAttributeValue, {
          removeFirstLine: true,
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
