import { z } from "zod";
import { RuntimeEnvironmentType } from "@trigger.dev/database";

// ============================================================================
// Batch Item Schemas
// ============================================================================

/**
 * A single item in a batch trigger request.
 * Kept permissive to accept various input formats from the API.
 *
 * Payload handling:
 * - For small payloads: `payload` contains the actual data, `payloadType` is "application/json" (default)
 * - For large payloads (offloaded to R2): `payload` is the R2 path string, `payloadType` is "application/store"
 *
 * When `payloadType` is "application/store", the payload is an R2 object path (e.g., "batch_xxx/item_0/payload.json")
 * that will be resolved by the run engine when the task executes.
 */
export const BatchItem = z.object({
  /** The task identifier to trigger */
  task: z.string(),
  /**
   * The payload for this item.
   * - If payloadType is "application/json": Contains the actual payload data
   * - If payloadType is "application/store": Contains the R2 path to the offloaded payload
   */
  payload: z.unknown().optional(),
  /**
   * The payload type.
   * - "application/json" (default): Payload is inline JSON data
   * - "application/store": Payload is an R2 object path (large payload was offloaded)
   * - Other types supported for non-JSON payloads
   */
  payloadType: z.string().optional(),
  /** Options for this specific item - stored as JSON */
  options: z.record(z.unknown()).optional(),
});
export type BatchItem = z.infer<typeof BatchItem>;

/**
 * Metadata stored alongside batch items in Redis
 */
export const BatchMeta = z.object({
  /** The batch ID */
  batchId: z.string(),
  /** The friendly batch ID */
  friendlyId: z.string(),
  /** Environment ID */
  environmentId: z.string(),
  /** Environment type */
  environmentType: z.nativeEnum(RuntimeEnvironmentType),
  /** Organization ID */
  organizationId: z.string(),
  /** Project ID */
  projectId: z.string(),
  /** Total number of items in the batch */
  runCount: z.number(),
  /** Timestamp when batch was created */
  createdAt: z.number(),
  /** Optional parent run ID (for triggerAndWait) */
  parentRunId: z.string().optional(),
  /** Whether to resume parent on completion */
  resumeParentOnCompletion: z.boolean().optional(),
  /** Trigger version */
  triggerVersion: z.string().optional(),
  /** Trace context */
  traceContext: z.record(z.unknown()).optional(),
  /** Whether span parent should be a link */
  spanParentAsLink: z.boolean().optional(),
  /** Realtime streams version */
  realtimeStreamsVersion: z.enum(["v1", "v2"]).optional(),
  /** Idempotency key for the batch */
  idempotencyKey: z.string().optional(),
  /** Processing concurrency limit for this batch's environment */
  processingConcurrency: z.number().optional(),
});
export type BatchMeta = z.infer<typeof BatchMeta>;

/**
 * A failure record for an item that failed to create a run.
 *
 * Payload handling:
 * - For small payloads: Contains the full payload as a JSON string
 * - For large payloads (offloaded to R2): Contains the R2 path string
 */
export const BatchItemFailure = z.object({
  /** Index of the item in the batch */
  index: z.number(),
  /** The task identifier */
  taskIdentifier: z.string(),
  /**
   * The payload that failed.
   * - For inline payloads: The full payload as a JSON string
   * - For offloaded payloads: The R2 path (e.g., "batch_xxx/item_0/payload.json")
   */
  payload: z.string().optional(),
  /** The options that were used */
  options: z.record(z.unknown()).optional(),
  /** Error message */
  error: z.string(),
  /** Error code if available */
  errorCode: z.string().optional(),
  /** Timestamp when the failure occurred */
  timestamp: z.number(),
});
export type BatchItemFailure = z.infer<typeof BatchItemFailure>;

// ============================================================================
// DRR (Deficit Round Robin) Types
// ============================================================================

/**
 * Configuration for the DRR scheduler
 */
export type DRRConfig = {
  /** Credits allocated per environment per round */
  quantum: number;
  /** Maximum accumulated deficit (prevents starvation) */
  maxDeficit: number;
};

// ============================================================================
// Batch Queue Options and Results
// ============================================================================

/**
 * Options for initializing a batch (Phase 1 of 2-phase batch API).
 * Items are streamed separately via enqueueBatchItem().
 */
export type InitializeBatchOptions = {
  /** The batch ID (internal format) */
  batchId: string;
  /** The friendly batch ID */
  friendlyId: string;
  /** Environment ID */
  environmentId: string;
  /** Environment type */
  environmentType: RuntimeEnvironmentType;
  /** Organization ID */
  organizationId: string;
  /** Project ID */
  projectId: string;
  /** Expected number of items in the batch */
  runCount: number;
  /** Optional parent run ID (for triggerAndWait) */
  parentRunId?: string;
  /** Whether to resume parent on completion */
  resumeParentOnCompletion?: boolean;
  /** Trigger version */
  triggerVersion?: string;
  /** Trace context */
  traceContext?: Record<string, unknown>;
  /** Whether span parent should be a link */
  spanParentAsLink?: boolean;
  /** Realtime streams version */
  realtimeStreamsVersion?: "v1" | "v2";
  /** Idempotency key for the batch */
  idempotencyKey?: string;
  /** Processing concurrency limit for this batch's environment */
  processingConcurrency?: number;
};

/**
 * Result of completing a batch
 */
export type CompleteBatchResult = {
  /** The batch ID */
  batchId: string;
  /** Friendly IDs of successfully created runs */
  runIds: string[];
  /** Count of successful runs */
  successfulRunCount: number;
  /** Count of failed items */
  failedRunCount: number;
  /** Failure details */
  failures: BatchItemFailure[];
};

/**
 * Options for the BatchQueue
 */
export type BatchQueueOptions = {
  /** Redis connection options */
  redis: {
    host: string;
    port: number;
    username?: string;
    password?: string;
    keyPrefix?: string;
    tls?: boolean;
    enableAutoPipelining?: boolean;
  };
  /** DRR configuration */
  drr: DRRConfig;
  /** Number of consumer loops to run */
  consumerCount: number;
  /** Interval between consumer iterations (ms) */
  consumerIntervalMs: number;
  /** Whether to start consumers on initialization */
  startConsumers?: boolean;
  /**
   * Default processing concurrency per environment.
   * This is used when no specific concurrency is set for an environment.
   * Items wait in queue until capacity frees up.
   */
  defaultConcurrency?: number;
  /**
   * Optional global rate limiter to limit processing across all consumers.
   * When configured, limits the max items/second processed globally.
   */
  globalRateLimiter?: import("@trigger.dev/redis-worker").GlobalRateLimiter;
  /** Logger instance */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
  /** OpenTelemetry tracer for distributed tracing */
  tracer?: import("@internal/tracing").Tracer;
  /** OpenTelemetry meter for metrics */
  meter?: import("@internal/tracing").Meter;
};

/**
 * Callback for processing a dequeued batch item
 */
export type ProcessBatchItemCallback = (params: {
  batchId: string;
  friendlyId: string;
  itemIndex: number;
  item: BatchItem;
  meta: BatchMeta;
}) => Promise<
  { success: true; runId: string } | { success: false; error: string; errorCode?: string }
>;

/**
 * Callback for handling batch completion
 */
export type BatchCompletionCallback = (result: CompleteBatchResult) => Promise<void>;

// ============================================================================
// FairQueue Payload Schema
// ============================================================================

/**
 * Payload schema for FairQueue messages.
 * Contains all data needed to process a single batch item.
 */
export const BatchItemPayload = z.object({
  /** Batch internal ID */
  batchId: z.string(),
  /** Batch friendly ID */
  friendlyId: z.string(),
  /** Index of this item in the batch (0-based) */
  itemIndex: z.number(),
  /** The actual item data */
  item: BatchItem,
});
export type BatchItemPayload = z.infer<typeof BatchItemPayload>;
