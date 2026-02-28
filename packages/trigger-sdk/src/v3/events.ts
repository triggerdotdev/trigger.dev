import {
  apiClientManager,
  getSchemaParseFn,
  resourceCatalog,
  runtime,
  taskContext,
} from "@trigger.dev/core/v3";
import type {
  EventWaitResult,
  inferSchemaIn,
  SchemaParseFn,
  TaskRunExecutionResult,
  TaskSchema,
} from "@trigger.dev/core/v3";

// Re-use TaskSchema which is the Schema type alias from core
type Schema = TaskSchema;

// ---- Types ----

/** Rate limit configuration for an event */
export interface EventRateLimit {
  /** Maximum number of publishes allowed in the window */
  limit: number;
  /** Time window — e.g. "1m", "10s", "1h" */
  window: string;
}

/** Options for defining an event */
export interface EventOptions<TId extends string, TSchema extends Schema | undefined = undefined> {
  /** Unique event identifier (e.g. "order.created") */
  id: TId;
  /** Optional schema for payload validation. Supports Zod, Valibot, ArkType, etc. */
  schema?: TSchema;
  /** Optional human-readable description */
  description?: string;
  /** Schema version (defaults to "1.0") */
  version?: string;
  /** Rate limit for publishing this event */
  rateLimit?: EventRateLimit;
}

/** Options for publishing an event */
export interface PublishEventOptions {
  /** Idempotency key to prevent duplicate publications */
  idempotencyKey?: string;
  /** Delay before triggering subscribers */
  delay?: string | Date;
  /** Tags to attach to the generated runs */
  tags?: string[];
  /** Metadata to attach to the generated runs */
  metadata?: Record<string, unknown>;
  /** Ordering key — events with the same ordering key are processed sequentially per consumer */
  orderingKey?: string;
}

/** Result of publishing an event */
export interface PublishEventResult {
  /** Unique ID of the published event instance */
  id: string;
  /** Runs created for each subscriber */
  runs: Array<{
    taskIdentifier: string;
    runId: string;
  }>;
}

/** Result of publishAndWait — aggregated results from all subscriber runs */
export interface PublishAndWaitResult {
  /** Unique ID of the published event instance */
  id: string;
  /** Results keyed by subscriber task identifier */
  results: Record<string, TaskRunExecutionResult>;
}

/** An event definition that can be published and subscribed to */
export interface EventDefinition<TId extends string, TPayload> {
  /** The event identifier */
  readonly id: TId;
  /** The schema version */
  readonly version: string;
  /** Optional description */
  readonly description?: string;
  /** The parse function derived from the schema, if provided */
  readonly _parseFn?: SchemaParseFn<TPayload>;

  /** Publish a single event payload to all subscribers */
  publish(payload: TPayload, options?: PublishEventOptions): Promise<PublishEventResult>;

  /** Publish multiple event payloads in a batch */
  batchPublish(
    items: Array<{ payload: TPayload; options?: PublishEventOptions }>
  ): Promise<Array<PublishEventResult>>;

  /**
   * Publish an event and wait for all subscriber runs to complete.
   * Can only be called from inside a task.run().
   */
  publishAndWait(payload: TPayload, options?: PublishEventOptions): Promise<PublishAndWaitResult>;
}

/** Any event definition (for generic constraints) */
export type AnyEventDefinition = EventDefinition<string, any>;

/** Extract the payload type from an EventDefinition */
export type EventDefinitionPayload<T extends AnyEventDefinition> =
  T extends EventDefinition<string, infer TPayload> ? TPayload : never;

/** Extract the ID type from an EventDefinition */
export type EventDefinitionId<T extends AnyEventDefinition> =
  T extends EventDefinition<infer TId, any> ? TId : never;

// ---- Implementation ----

// Overload: with schema — payload type is inferred from schema
export function createEvent<TId extends string, TSchema extends Schema>(
  options: EventOptions<TId, TSchema> & { schema: TSchema }
): EventDefinition<TId, inferSchemaIn<TSchema>>;

// Overload: without schema — payload type is unknown
export function createEvent<TId extends string>(
  options: EventOptions<TId, undefined>
): EventDefinition<TId, unknown>;

// Overload: without schema (no schema field at all)
export function createEvent<TId extends string>(
  options: Omit<EventOptions<TId>, "schema">
): EventDefinition<TId, unknown>;

// Implementation
export function createEvent<TId extends string, TSchema extends Schema | undefined = undefined>(
  options: EventOptions<TId, TSchema>
): EventDefinition<TId, any> {
  const { id, schema, description, version = "1.0", rateLimit } = options;

  // Build the parse function if a schema is provided
  let parseFn: SchemaParseFn<any> | undefined;
  if (schema) {
    parseFn = getSchemaParseFn(schema);
  }

  const eventDef: EventDefinition<TId, any> = {
    id,
    version,
    description,
    _parseFn: parseFn,

    async publish(payload, options) {
      // Validate payload if a schema was provided
      const validatedPayload = parseFn ? await parseFn(payload) : payload;

      const apiClient = apiClientManager.clientOrThrow();

      const result = await apiClient.publishEvent(id, {
        payload: validatedPayload,
        options: options
          ? {
              idempotencyKey: options.idempotencyKey,
              delay: options.delay instanceof Date ? options.delay.toISOString() : options.delay,
              tags: options.tags,
              metadata: options.metadata,
              orderingKey: options.orderingKey,
            }
          : undefined,
      });

      return {
        id: result.eventId,
        runs: result.runs,
      };
    },

    async publishAndWait(payload, options) {
      const ctx = taskContext.ctx;
      if (!ctx) {
        throw new Error("publishAndWait can only be used from inside a task.run()");
      }

      const validatedPayload = parseFn ? await parseFn(payload) : payload;
      const apiClient = apiClientManager.clientOrThrow();

      const response = await apiClient.publishAndWaitEvent(id, {
        payload: validatedPayload,
        options: options
          ? {
              idempotencyKey: options.idempotencyKey,
              delay: options.delay instanceof Date ? options.delay.toISOString() : options.delay,
              tags: options.tags,
              metadata: options.metadata,
              orderingKey: options.orderingKey,
              parentRunId: ctx.run.id,
            }
          : {
              parentRunId: ctx.run.id,
            },
      });

      if (response.runs.length === 0) {
        return { id: response.eventId, results: {} };
      }

      const waitResult = await runtime.waitForEvent({
        eventId: response.eventId,
        runs: response.runs.map((r) => ({
          friendlyId: r.runId,
          taskSlug: r.taskIdentifier,
        })),
        ctx,
      });

      return {
        id: waitResult.id,
        results: waitResult.results,
      };
    },

    async batchPublish(items) {
      const apiClient = apiClientManager.clientOrThrow();

      const validatedItems = await Promise.all(
        items.map(async (item) => {
          const validatedPayload = parseFn ? await parseFn(item.payload) : item.payload;
          return {
            payload: validatedPayload,
            options: item.options
              ? {
                  idempotencyKey: item.options.idempotencyKey,
                  delay:
                    item.options.delay instanceof Date
                      ? item.options.delay.toISOString()
                      : item.options.delay,
                  tags: item.options.tags,
                  metadata: item.options.metadata,
                  orderingKey: item.options.orderingKey,
                }
              : undefined,
          };
        })
      );

      const result = await apiClient.batchPublishEvent(id, {
        items: validatedItems,
      });

      return result.results.map((r) => ({
        id: r.eventId,
        runs: r.runs,
      }));
    },
  };

  // Register event metadata in the resource catalog (including raw schema for JSON Schema conversion)
  resourceCatalog.registerEventMetadata({
    id,
    version,
    description,
    rawSchema: schema,
    rateLimit,
  });

  // Mark as event for runtime detection
  // @ts-expect-error - adding symbol property
  eventDef[Symbol.for("trigger.dev/event")] = true;

  return eventDef;
}

/** The public `event()` function for defining events */
export const event = createEvent;

/** Check if a value is an EventDefinition */
export function isEventDefinition(value: unknown): value is AnyEventDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as any)[Symbol.for("trigger.dev/event")] === true
  );
}

// ---- Pattern-based subscriptions ----

/** A pattern-based event matcher for wildcard subscriptions */
export interface EventPatternMatcher {
  /** The event pattern used as the subscription identifier */
  readonly id: string;
  /** Version (always "1.0" for patterns) */
  readonly version: string;
  /** The wildcard pattern */
  readonly pattern: string;
}

/**
 * Create a pattern-based event matcher for wildcard subscriptions.
 *
 * Patterns use dot-separated segments with two wildcards:
 * - `*` matches exactly one segment (e.g., `order.*` matches `order.created`)
 * - `#` matches zero or more segments (e.g., `order.#` matches `order.status.changed`)
 *
 * @example
 * ```ts
 * import { events, task } from "@trigger.dev/sdk";
 *
 * // Subscribe to all order events
 * export const orderHandler = task({
 *   id: "order-handler",
 *   on: events.match("order.*"),
 *   run: async (payload) => { ... }
 * });
 * ```
 */
export function matchEvents(pattern: string): EventPatternMatcher {
  return {
    id: `pattern:${pattern}`,
    version: "1.0",
    pattern,
  };
}

/** Namespace for event utilities */
export const events = {
  match: matchEvents,
};

/** Check if an event source is a pattern matcher */
export function isEventPatternMatcher(value: unknown): value is EventPatternMatcher {
  return (
    typeof value === "object" &&
    value !== null &&
    "pattern" in value &&
    typeof (value as any).pattern === "string"
  );
}
