import type { FairQueueKeyProducer } from "./types.js";

/**
 * Default key producer for the fair queue system.
 * Uses a configurable prefix and standard key structure.
 *
 * Key structure:
 * - Master queue: {prefix}:master:{shardId}
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
