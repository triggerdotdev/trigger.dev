import type { RedisOptions } from "@internal/redis";
import type { Logger } from "@trigger.dev/core/logger";
import type { Tracer, Meter } from "@internal/tracing";
import type { z } from "zod";
import type { RetryStrategy } from "./retry.js";

// ============================================================================
// Core Queue Types
// ============================================================================

/**
 * Descriptor for a queue in the fair queue system.
 * Contains all the metadata needed to identify and route a queue.
 */
export interface QueueDescriptor {
  /** Unique queue identifier */
  id: string;
  /** Tenant this queue belongs to */
  tenantId: string;
  /** Additional metadata for concurrency group extraction */
  metadata: Record<string, string>;
}

/**
 * A message in the queue with its metadata.
 */
export interface QueueMessage<TPayload = unknown> {
  /** Unique message identifier */
  id: string;
  /** The queue this message belongs to */
  queueId: string;
  /** Message payload */
  payload: TPayload;
  /** Timestamp when message was enqueued */
  timestamp: number;
  /** Current attempt number (1-indexed, for retries) */
  attempt: number;
  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Internal message format stored in Redis.
 * Includes additional fields for tracking and routing.
 */
export interface StoredMessage<TPayload = unknown> {
  /** Message ID */
  id: string;
  /** Queue ID */
  queueId: string;
  /** Tenant ID */
  tenantId: string;
  /** Message payload */
  payload: TPayload;
  /** Timestamp when enqueued */
  timestamp: number;
  /** Current attempt number */
  attempt: number;
  /** Worker queue to route to */
  workerQueue?: string;
  /** Additional metadata */
  metadata?: Record<string, string>;
}

/**
 * Queue with its score (oldest message timestamp) from the master queue.
 */
export interface QueueWithScore {
  /** Queue identifier */
  queueId: string;
  /** Score (typically oldest message timestamp) */
  score: number;
  /** Tenant ID extracted from queue */
  tenantId: string;
}

// ============================================================================
// Concurrency Types
// ============================================================================

/**
 * Configuration for a concurrency group.
 * Allows defining arbitrary levels of concurrency (tenant, org, project, etc.)
 */
export interface ConcurrencyGroupConfig {
  /** Group name (e.g., "tenant", "organization", "project") */
  name: string;
  /** Extract the group ID from a queue descriptor */
  extractGroupId: (queue: QueueDescriptor) => string;
  /** Get the concurrency limit for a specific group ID */
  getLimit: (groupId: string) => Promise<number>;
  /** Default limit if not specified */
  defaultLimit: number;
}

/**
 * Current concurrency state for a group.
 */
export interface ConcurrencyState {
  /** Group name */
  groupName: string;
  /** Group ID */
  groupId: string;
  /** Current active count */
  current: number;
  /** Configured limit */
  limit: number;
}

/**
 * Result of a concurrency check.
 */
export interface ConcurrencyCheckResult {
  /** Whether processing is allowed */
  allowed: boolean;
  /** If not allowed, which group is blocking */
  blockedBy?: ConcurrencyState;
}

// ============================================================================
// Scheduler Types
// ============================================================================

/**
 * Queues grouped by tenant for the scheduler.
 */
export interface TenantQueues {
  /** Tenant identifier */
  tenantId: string;
  /** Queue IDs belonging to this tenant, in priority order */
  queues: string[];
}

/**
 * Context provided to the scheduler for making decisions.
 */
export interface SchedulerContext {
  /** Get current concurrency for a group */
  getCurrentConcurrency(groupName: string, groupId: string): Promise<number>;
  /** Get concurrency limit for a group */
  getConcurrencyLimit(groupName: string, groupId: string): Promise<number>;
  /** Check if a group is at capacity */
  isAtCapacity(groupName: string, groupId: string): Promise<boolean>;
  /** Get queue descriptor by ID */
  getQueueDescriptor(queueId: string): QueueDescriptor;
}

/**
 * Pluggable scheduler interface for fair queue selection.
 */
export interface FairScheduler {
  /**
   * Select queues for processing from a master queue shard.
   * Returns queues grouped by tenant, ordered by the fairness algorithm.
   *
   * @param masterQueueShard - The master queue shard key
   * @param consumerId - The consumer making the request
   * @param context - Context for concurrency checks
   * @returns Queues grouped by tenant in priority order
   */
  selectQueues(
    masterQueueShard: string,
    consumerId: string,
    context: SchedulerContext
  ): Promise<TenantQueues[]>;

  /**
   * Called after processing a message to update scheduler state.
   * Optional - not all schedulers need to track state.
   */
  recordProcessed?(tenantId: string, queueId: string): Promise<void>;

  /**
   * Initialize the scheduler (called once on startup).
   */
  initialize?(): Promise<void>;

  /**
   * Cleanup scheduler resources.
   */
  close?(): Promise<void>;
}

// ============================================================================
// Visibility Timeout Types
// ============================================================================

/**
 * An in-flight message being processed.
 */
export interface InFlightMessage<TPayload = unknown> {
  /** Message ID */
  messageId: string;
  /** Queue ID */
  queueId: string;
  /** Message payload */
  payload: TPayload;
  /** When visibility timeout expires */
  deadline: number;
  /** Consumer that claimed this message */
  consumerId: string;
}

/**
 * Result of claiming a message.
 */
export interface ClaimResult<TPayload = unknown> {
  /** Whether the claim was successful */
  claimed: boolean;
  /** The claimed message if successful */
  message?: InFlightMessage<TPayload>;
}

// ============================================================================
// Key Producer Interface
// ============================================================================

/**
 * Interface for generating Redis keys for the fair queue system.
 * Implementations can customize key prefixes and structures.
 */
export interface FairQueueKeyProducer {
  // Master queue keys
  /** Get the master queue key for a shard */
  masterQueueKey(shardId: number): string;

  // Individual queue keys
  /** Get the queue key for storing messages */
  queueKey(queueId: string): string;
  /** Get the queue items hash key */
  queueItemsKey(queueId: string): string;

  // Concurrency tracking keys
  /** Get the concurrency set key for a group */
  concurrencyKey(groupName: string, groupId: string): string;

  // In-flight tracking keys
  /** Get the in-flight sorted set key for a shard */
  inflightKey(shardId: number): string;
  /** Get the in-flight message data hash key */
  inflightDataKey(shardId: number): string;

  // Worker queue keys
  /** Get the worker queue key for a consumer */
  workerQueueKey(consumerId: string): string;

  // Dead letter queue keys
  /** Get the dead letter queue key for a tenant */
  deadLetterQueueKey(tenantId: string): string;
  /** Get the dead letter queue data hash key for a tenant */
  deadLetterQueueDataKey(tenantId: string): string;

  // Extraction methods
  /** Extract tenant ID from a queue ID */
  extractTenantId(queueId: string): string;
  /** Extract a specific group ID from a queue ID */
  extractGroupId(groupName: string, queueId: string): string;
}

// ============================================================================
// FairQueue Options
// ============================================================================

/**
 * Worker queue configuration options.
 */
export interface WorkerQueueOptions<TPayload = unknown> {
  /** Whether to enable worker queues (default: false for backwards compatibility) */
  enabled: boolean;
  /** Blocking pop timeout in seconds (default: 10) */
  blockingTimeoutSeconds?: number;
  /** Function to resolve which worker queue a message should go to */
  resolveWorkerQueue?: (message: StoredMessage<TPayload>) => string;
}

/**
 * Retry and dead letter queue configuration.
 */
export interface RetryOptions {
  /** Retry strategy for failed messages */
  strategy: RetryStrategy;
  /** Whether to enable dead letter queue (default: true) */
  deadLetterQueue?: boolean;
}

/**
 * Queue cooloff configuration to avoid repeatedly polling concurrency-limited queues.
 */
export interface CooloffOptions {
  /** Whether cooloff is enabled (default: true) */
  enabled?: boolean;
  /** Number of consecutive empty dequeues before entering cooloff (default: 10) */
  threshold?: number;
  /** Duration of cooloff period in milliseconds (default: 10000) */
  periodMs?: number;
}

/**
 * Options for creating a FairQueue instance.
 *
 * @typeParam TPayloadSchema - Zod schema for message payload validation
 */
export interface FairQueueOptions<TPayloadSchema extends z.ZodTypeAny = z.ZodUnknown> {
  /** Redis connection options */
  redis: RedisOptions;

  /** Key producer for Redis keys */
  keys: FairQueueKeyProducer;

  /** Scheduler for fair queue selection */
  scheduler: FairScheduler;

  // Payload validation
  /** Zod schema for message payload validation */
  payloadSchema?: TPayloadSchema;
  /** Whether to validate payloads on enqueue (default: false) */
  validateOnEnqueue?: boolean;

  // Sharding
  /** Number of master queue shards (default: 1) */
  shardCount?: number;

  // Concurrency
  /** Concurrency group configurations */
  concurrencyGroups?: ConcurrencyGroupConfig[];

  // Worker queue
  /** Worker queue configuration */
  workerQueue?: WorkerQueueOptions<z.infer<TPayloadSchema>>;

  // Retry and DLQ
  /** Retry and dead letter queue configuration */
  retry?: RetryOptions;

  // Visibility timeout
  /** Visibility timeout in milliseconds (default: 30000) */
  visibilityTimeoutMs?: number;
  /** Heartbeat interval in milliseconds (default: visibilityTimeoutMs / 3) */
  heartbeatIntervalMs?: number;
  /** Interval for reclaiming timed-out messages (default: 5000) */
  reclaimIntervalMs?: number;

  // Consumers
  /** Number of consumer loops to run (default: 1) */
  consumerCount?: number;
  /** Interval between consumer iterations in milliseconds (default: 100) */
  consumerIntervalMs?: number;
  /** Whether to start consumers on initialization (default: true) */
  startConsumers?: boolean;

  // Cooloff
  /** Queue cooloff configuration */
  cooloff?: CooloffOptions;

  // Observability
  /** Logger instance */
  logger?: Logger;
  /** OpenTelemetry tracer */
  tracer?: Tracer;
  /** OpenTelemetry meter */
  meter?: Meter;
  /** Name for metrics/tracing (default: "fairqueue") */
  name?: string;
}

// ============================================================================
// Message Handler Types
// ============================================================================

/**
 * Context passed to the message handler.
 */
export interface MessageHandlerContext<TPayload = unknown> {
  /** The message being processed */
  message: QueueMessage<TPayload>;
  /** Queue descriptor */
  queue: QueueDescriptor;
  /** Consumer ID processing this message */
  consumerId: string;
  /** Extend the visibility timeout */
  heartbeat(): Promise<boolean>;
  /** Mark message as successfully processed */
  complete(): Promise<void>;
  /** Release message back to the queue for retry */
  release(): Promise<void>;
  /** Mark message as failed (triggers retry or DLQ) */
  fail(error?: Error): Promise<void>;
}

/**
 * Handler function for processing messages.
 */
export type MessageHandler<TPayload = unknown> = (
  context: MessageHandlerContext<TPayload>
) => Promise<void>;

// ============================================================================
// Dead Letter Queue Types
// ============================================================================

/**
 * A message in the dead letter queue.
 */
export interface DeadLetterMessage<TPayload = unknown> {
  /** Message ID */
  id: string;
  /** Original queue ID */
  queueId: string;
  /** Tenant ID */
  tenantId: string;
  /** Message payload */
  payload: TPayload;
  /** Timestamp when moved to DLQ */
  deadLetteredAt: number;
  /** Number of attempts before DLQ */
  attempts: number;
  /** Last error message if available */
  lastError?: string;
  /** Original message timestamp */
  originalTimestamp: number;
}

// ============================================================================
// Cooloff State Types
// ============================================================================

/**
 * Cooloff state for a queue.
 */
export type QueueCooloffState =
  | { tag: "normal"; consecutiveFailures: number }
  | { tag: "cooloff"; expiresAt: number };

// ============================================================================
// Enqueue Options
// ============================================================================

/**
 * Options for enqueueing a message.
 */
export interface EnqueueOptions<TPayload = unknown> {
  /** Queue to add the message to */
  queueId: string;
  /** Tenant ID for the queue */
  tenantId: string;
  /** Message payload */
  payload: TPayload;
  /** Optional message ID (auto-generated if not provided) */
  messageId?: string;
  /** Optional timestamp (defaults to now) */
  timestamp?: number;
  /** Optional metadata for concurrency group extraction */
  metadata?: Record<string, string>;
}

/**
 * Options for enqueueing multiple messages.
 */
export interface EnqueueBatchOptions<TPayload = unknown> {
  /** Queue to add messages to */
  queueId: string;
  /** Tenant ID for the queue */
  tenantId: string;
  /** Messages to enqueue */
  messages: Array<{
    payload: TPayload;
    messageId?: string;
    timestamp?: number;
  }>;
  /** Optional metadata for concurrency group extraction */
  metadata?: Record<string, string>;
}

// ============================================================================
// DRR Scheduler Types
// ============================================================================

/**
 * Configuration for the Deficit Round Robin scheduler.
 */
export interface DRRSchedulerConfig {
  /** Credits allocated per tenant per round */
  quantum: number;
  /** Maximum accumulated deficit (prevents starvation) */
  maxDeficit: number;
  /** Redis options for state storage */
  redis: RedisOptions;
  /** Key producer */
  keys: FairQueueKeyProducer;
  /** Optional logger */
  logger?: {
    debug: (message: string, context?: Record<string, unknown>) => void;
    error: (message: string, context?: Record<string, unknown>) => void;
  };
}

// ============================================================================
// Weighted Scheduler Types
// ============================================================================

/**
 * Bias configuration for weighted shuffle scheduler.
 */
export interface WeightedSchedulerBiases {
  /**
   * How much to bias towards tenants with higher concurrency limits.
   * 0 = no bias, 1 = full bias based on limit differences
   */
  concurrencyLimitBias: number;

  /**
   * How much to bias towards tenants with more available capacity.
   * 0 = no bias, 1 = full bias based on available capacity
   */
  availableCapacityBias: number;

  /**
   * Controls randomization of queue ordering within tenants.
   * 0 = strict age-based ordering (oldest first)
   * 1 = completely random ordering
   * Values between 0-1 blend between age-based and random ordering
   */
  queueAgeRandomization: number;
}

/**
 * Configuration for the weighted shuffle scheduler.
 */
export interface WeightedSchedulerConfig {
  /** Redis options */
  redis: RedisOptions;
  /** Key producer */
  keys: FairQueueKeyProducer;
  /** Default tenant concurrency limit */
  defaultTenantConcurrencyLimit?: number;
  /** Maximum queues to consider from master queue */
  masterQueueLimit?: number;
  /** Bias configuration */
  biases?: WeightedSchedulerBiases;
  /** Number of iterations to reuse a snapshot */
  reuseSnapshotCount?: number;
  /** Maximum number of tenants to consider */
  maximumTenantCount?: number;
  /** Random seed for reproducibility */
  seed?: string;
  /** Optional tracer */
  tracer?: Tracer;
}
