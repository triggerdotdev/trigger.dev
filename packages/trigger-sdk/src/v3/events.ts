import {
  getSchemaParseFn,
  resourceCatalog,
} from "@trigger.dev/core/v3";
import type {
  inferSchemaIn,
  SchemaParseFn,
  TaskSchema,
} from "@trigger.dev/core/v3";

// Re-use TaskSchema which is the Schema type alias from core
type Schema = TaskSchema;

// ---- Types ----

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
  const { id, schema, description, version = "1.0" } = options;

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

    // Publish will be connected in Phase 0.8 when API endpoints exist
    async publish(_payload, _options) {
      throw new Error(
        `event("${id}").publish() is not yet connected to the API. ` +
          `The publish endpoint will be available after the backend is deployed.`
      );
    },

    async batchPublish(_items) {
      throw new Error(
        `event("${id}").batchPublish() is not yet connected to the API. ` +
          `The publish endpoint will be available after the backend is deployed.`
      );
    },
  };

  // Register event metadata in the resource catalog
  resourceCatalog.registerEventMetadata({
    id,
    version,
    description,
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
