import { z } from "zod";
import { RuntimeEnvironmentType } from "@trigger.dev/database";

// ============================================================================
// Batch Item Schemas
// ============================================================================

/**
 * A single item in a batch trigger request.
 * Kept permissive to accept various input formats from the API.
 */
export const BatchItem = z.object({
  /** The task identifier to trigger */
  task: z.string(),
  /** The payload for this item */
  payload: z.unknown().optional(),
  /** The payload type */
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
  /** Plan type for entitlement */
  planType: z.string().optional(),
});
export type BatchMeta = z.infer<typeof BatchMeta>;

/**
 * A failure record for an item that failed to create a run
 */
export const BatchItemFailure = z.object({
  /** Index of the item in the batch */
  index: z.number(),
  /** The task identifier */
  taskIdentifier: z.string(),
  /** The payload (may be truncated) */
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
 * State for a single environment in the DRR scheduler
 */
export type DRREnvironmentState = {
  /** Environment ID */
  envId: string;
  /** Current deficit (accumulated credits) */
  deficit: number;
  /** Last time this env was served */
  lastServedAt: number;
};

/**
 * Result of a DRR dequeue operation
 */
export type DRRDequeueResult = {
  /** Environment ID that was selected */
  envId: string;
  /** Batch ID that was selected */
  batchId: string;
  /** Item index that was dequeued */
  itemIndex: number;
  /** The item payload */
  item: BatchItem;
  /** Batch metadata */
  meta: BatchMeta;
  /** Whether this was the last item in the batch */
  isBatchComplete: boolean;
  /** Whether this environment has more batches */
  envHasMoreBatches: boolean;
};

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
// Batch Queue Key Producer Interface
// ============================================================================

/**
 * Interface for generating Redis keys for the batch queue system
 */
export interface BatchQueueKeyProducer {
  // Master queue keys (DRR scheduling)
  /** Key for the master queue sorted set (members are "{envId}:{batchId}") */
  masterQueueKey(): string;
  /** Key for DRR deficit hash (per-env deficit counters) */
  deficitHashKey(): string;

  // Per-batch keys
  /** Key for a batch's item queue (sorted set of pending indices) */
  batchQueueKey(batchId: string): string;
  /** Key for a batch's items hash (index -> payload JSON) */
  batchItemsKey(batchId: string): string;
  /** Key for a batch's metadata hash */
  batchMetaKey(batchId: string): string;
  /** Key for a batch's successful runs list */
  batchRunsKey(batchId: string): string;
  /** Key for a batch's failure list */
  batchFailuresKey(batchId: string): string;
  /** Key for a batch's processed count (atomic counter) */
  batchProcessedCountKey(batchId: string): string;

  // Master queue member utilities
  /** Create a master queue member value: "{envId}:{batchId}" */
  masterQueueMember(envId: string, batchId: string): string;
  /** Parse a master queue member to extract envId and batchId */
  parseMasterQueueMember(member: string): { envId: string; batchId: string };

  // Utility methods
  /** Extract batch ID from a batch queue key */
  batchIdFromKey(key: string): string;
}

// ============================================================================
// Batch Queue Options and Results
// ============================================================================

/**
 * Options for enqueueing a batch
 */
export type EnqueueBatchOptions = {
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
  /** The batch items */
  items: BatchItem[];
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
  /** Plan type for entitlement */
  planType?: string;
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
  /** Logger instance */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    info: (message: string, context?: Record<string, unknown>) => void;
    warn: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
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
  | { success: true; runId: string }
  | { success: false; error: string; errorCode?: string }
>;

/**
 * Callback for handling batch completion
 */
export type BatchCompletionCallback = (result: CompleteBatchResult) => Promise<void>;

