import { jumpHash } from "@trigger.dev/core/v3/serverOnly";
import type { FairQueueKeyProducer } from "./types.js";

/**
 * Default key producer for the fair queue system.
 * Uses a configurable prefix and standard key structure.
 *
 * Key structure:
 * - Master queue: {prefix}:master:{shardId} (legacy, drain-only)
 * - Dispatch index: {prefix}:dispatch:{shardId} (Level 1: tenantIds)
 * - Tenant queue index: {prefix}:tenantq:{tenantId} (Level 2: queueIds)
 * - Queue: {prefix}:queue:{queueId}
 * - Queue items: {prefix}:queue:{queueId}:items
 * - Concurrency: {prefix}:concurrency:{groupName}:{groupId}
 * - In-flight: {prefix}:inflight:{shardId}
 * - In-flight data: {prefix}:inflight:{shardId}:data
 * - Worker queue: {prefix}:worker:{consumerId}
 */
export class DefaultFairQueueKeyProducer implements FairQueueKeyProducer {
  private readonly prefix: string;
  private readonly separator: string;

  constructor(options: { prefix?: string; separator?: string } = {}) {
    this.prefix = options.prefix ?? "fq";
    this.separator = options.separator ?? ":";
  }

  // ============================================================================
  // Master Queue Keys
  // ============================================================================

  masterQueueKey(shardId: number): string {
    return this.#buildKey("master", shardId.toString());
  }

  // ============================================================================
  // Queue Keys
  // ============================================================================

  queueKey(queueId: string): string {
    return this.#buildKey("queue", queueId);
  }

  queueItemsKey(queueId: string): string {
    return this.#buildKey("queue", queueId, "items");
  }

  // ============================================================================
  // Concurrency Keys
  // ============================================================================

  concurrencyKey(groupName: string, groupId: string): string {
    return this.#buildKey("concurrency", groupName, groupId);
  }

  // ============================================================================
  // In-Flight Keys
  // ============================================================================

  inflightKey(shardId: number): string {
    return this.#buildKey("inflight", shardId.toString());
  }

  inflightDataKey(shardId: number): string {
    return this.#buildKey("inflight", shardId.toString(), "data");
  }

  // ============================================================================
  // Worker Queue Keys
  // ============================================================================

  workerQueueKey(consumerId: string): string {
    return this.#buildKey("worker", consumerId);
  }

  // ============================================================================
  // Tenant Dispatch Keys (Two-Level Index)
  // ============================================================================

  dispatchKey(shardId: number): string {
    return this.#buildKey("dispatch", shardId.toString());
  }

  tenantQueueIndexKey(tenantId: string): string {
    return this.#buildKey("tenantq", tenantId);
  }

  // ============================================================================
  // Dead Letter Queue Keys
  // ============================================================================

  deadLetterQueueKey(tenantId: string): string {
    return this.#buildKey("dlq", tenantId);
  }

  deadLetterQueueDataKey(tenantId: string): string {
    return this.#buildKey("dlq", tenantId, "data");
  }

  // ============================================================================
  // Extraction Methods
  // ============================================================================

  /**
   * Extract tenant ID from a queue ID.
   * Default implementation assumes queue IDs are formatted as: tenant:{tenantId}:...
   * Override this method for custom queue ID formats.
   */
  extractTenantId(queueId: string): string {
    const parts = queueId.split(this.separator);
    // Expect format: tenant:{tenantId}:...
    if (parts.length >= 2 && parts[0] === "tenant" && parts[1]) {
      return parts[1];
    }
    // Fallback: return the first segment
    return parts[0] ?? "";
  }

  /**
   * Extract a group ID from a queue ID.
   * Default implementation looks for pattern: {groupName}:{groupId}:...
   * Override this method for custom queue ID formats.
   */
  extractGroupId(groupName: string, queueId: string): string {
    const parts = queueId.split(this.separator);

    // Look for the group name in the queue ID parts
    for (let i = 0; i < parts.length - 1; i++) {
      if (parts[i] === groupName) {
        const nextPart = parts[i + 1];
        if (nextPart) {
          return nextPart;
        }
      }
    }

    // Fallback: return an empty string
    return "";
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  #buildKey(...parts: string[]): string {
    return [this.prefix, ...parts].join(this.separator);
  }
}

/**
 * Key producer with custom extraction logic via callbacks.
 * Useful when queue IDs don't follow a standard pattern.
 */
export class CallbackFairQueueKeyProducer extends DefaultFairQueueKeyProducer {
  private readonly tenantExtractor: (queueId: string) => string;
  private readonly groupExtractor: (groupName: string, queueId: string) => string;

  constructor(options: {
    prefix?: string;
    separator?: string;
    extractTenantId: (queueId: string) => string;
    extractGroupId: (groupName: string, queueId: string) => string;
  }) {
    super({ prefix: options.prefix, separator: options.separator });
    this.tenantExtractor = options.extractTenantId;
    this.groupExtractor = options.extractGroupId;
  }

  override extractTenantId(queueId: string): string {
    return this.tenantExtractor(queueId);
  }

  override extractGroupId(groupName: string, queueId: string): string {
    return this.groupExtractor(groupName, queueId);
  }
}

/**
 * Key producer for running a fair queue on a Redis cluster. Each tenant belongs to one shard,
 * `jumpHash(tenantId, shardCount)`, and every key of a shard carries the hash tag
 * `{prefix:shard}`, so a shard's queues, items, payloads, tenant indexes, dispatch index,
 * in-flight set and concurrency sets share a slot and every script stays single-slot.
 *
 * Concurrency groups must be keyed by tenant id. The shard count can't change without moving keys.
 *
 * Key structure (S = the tenant's shard):
 * - Dispatch index: {prefix:S}:dispatch
 * - Tenant queue index: {prefix:S}:tenantq:{tenantId}
 * - Queue: {prefix:S}:queue:{queueId}, items {prefix:S}:queue:{queueId}:items
 * - Payload: {prefix:S}:payload:{queueId}:{messageId}
 * - Payload bytes per tenant: {prefix:S}:payloadbytes:{tenantId}
 * - Concurrency: {prefix:S}:concurrency:{groupName}:{tenantId}
 * - In-flight: {prefix:S}:inflight, data {prefix:S}:inflight:data
 * - Dead letter queue: {prefix:S}:dlq:{tenantId}, data {prefix:S}:dlq:{tenantId}:data
 * - Legacy master queue: {prefix:S}:master
 * - Worker queue: {prefix}:worker:{consumerId} (its own slot)
 * - DRR deficits: {prefix}:drr:deficit (its own slot)
 */
export class TenantShardedFairQueueKeyProducer implements FairQueueKeyProducer {
  readonly shardCount: number;
  private readonly prefix: string;
  private readonly tenantExtractor: (queueId: string) => string;
  private readonly groupExtractor: (groupName: string, queueId: string) => string;

  constructor(options: {
    prefix: string;
    shardCount: number;
    extractTenantId: (queueId: string) => string;
    extractGroupId: (groupName: string, queueId: string) => string;
  }) {
    if (!Number.isInteger(options.shardCount) || options.shardCount < 1) {
      throw new Error(`shardCount must be a positive integer, got ${options.shardCount}`);
    }
    this.prefix = options.prefix;
    this.shardCount = options.shardCount;
    this.tenantExtractor = options.extractTenantId;
    this.groupExtractor = options.extractGroupId;
  }

  tenantShard(tenantId: string): number {
    return jumpHash(tenantId, this.shardCount);
  }

  masterQueueKey(shardId: number): string {
    return `${this.#tag(shardId)}:master`;
  }

  queueKey(queueId: string): string {
    return `${this.#queueTag(queueId)}:queue:${queueId}`;
  }

  queueItemsKey(queueId: string): string {
    return `${this.#queueTag(queueId)}:queue:${queueId}:items`;
  }

  payloadKey(queueId: string, messageId: string): string {
    return `${this.#queueTag(queueId)}:payload:${queueId}:${messageId}`;
  }

  tenantPayloadBytesKey(tenantId: string): string {
    return `${this.#tag(this.tenantShard(tenantId))}:payloadbytes:${tenantId}`;
  }

  concurrencyKey(groupName: string, groupId: string): string {
    return `${this.#tag(this.tenantShard(groupId))}:concurrency:${groupName}:${groupId}`;
  }

  concurrencyKeyPattern(groupName: string, shardId: number): string {
    return `${this.#tag(shardId)}:concurrency:${groupName}:*`;
  }

  inflightKey(shardId: number): string {
    return `${this.#tag(shardId)}:inflight`;
  }

  inflightDataKey(shardId: number): string {
    return `${this.#tag(shardId)}:inflight:data`;
  }

  workerQueueKey(consumerId: string): string {
    return `${this.prefix}:worker:${consumerId}`;
  }

  deadLetterQueueKey(tenantId: string): string {
    return `${this.#tag(this.tenantShard(tenantId))}:dlq:${tenantId}`;
  }

  deadLetterQueueDataKey(tenantId: string): string {
    return `${this.#tag(this.tenantShard(tenantId))}:dlq:${tenantId}:data`;
  }

  dispatchKey(shardId: number): string {
    return `${this.#tag(shardId)}:dispatch`;
  }

  tenantQueueIndexKey(tenantId: string): string {
    return `${this.#tag(this.tenantShard(tenantId))}:tenantq:${tenantId}`;
  }

  drrDeficitKey(): string {
    return `${this.prefix}:drr:deficit`;
  }

  extractTenantId(queueId: string): string {
    return this.tenantExtractor(queueId);
  }

  extractGroupId(groupName: string, queueId: string): string {
    return this.groupExtractor(groupName, queueId);
  }

  #queueTag(queueId: string): string {
    return this.#tag(this.tenantShard(this.tenantExtractor(queueId)));
  }

  #tag(shardId: number): string {
    return `{${this.prefix}:${shardId}}`;
  }
}
