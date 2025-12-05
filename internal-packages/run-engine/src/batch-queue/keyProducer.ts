import type { BatchQueueKeyProducer } from "./types.js";

const constants = {
  BATCH_PART: "batch",
  MASTER_QUEUE_PART: "master",
  DEFICIT_PART: "deficit",
  ITEMS_PART: "items",
  META_PART: "meta",
  QUEUE_PART: "queue",
  RUNS_PART: "runs",
  FAILURES_PART: "failures",
} as const;

/**
 * Generates Redis keys for the batch queue system.
 *
 * Key structure:
 * - batch:master - Master queue (sorted set of "{envId}:{batchId}" members)
 * - batch:deficit - DRR deficit hash (envId -> deficit value)
 * - batch:{batchId}:queue - Per-batch item queue (sorted set of indices)
 * - batch:{batchId}:items - Per-batch items hash (index -> payload JSON)
 * - batch:{batchId}:meta - Per-batch metadata
 * - batch:{batchId}:runs - Per-batch successful runs (list of runIds)
 * - batch:{batchId}:failures - Per-batch failures (list of failure JSON)
 */
export class BatchQueueFullKeyProducer implements BatchQueueKeyProducer {
  /**
   * Key for the master queue sorted set.
   * Contains members in format "{envId}:{batchId}" scored by creation time.
   */
  masterQueueKey(): string {
    return [constants.BATCH_PART, constants.MASTER_QUEUE_PART].join(":");
  }

  /**
   * Key for the DRR deficit hash.
   * Maps environment ID to current deficit counter.
   */
  deficitHashKey(): string {
    return [constants.BATCH_PART, constants.DEFICIT_PART].join(":");
  }

  /**
   * Key for a batch's item queue sorted set.
   * Contains item indices scored by their position (for ordered processing).
   */
  batchQueueKey(batchId: string): string {
    return [constants.BATCH_PART, batchId, constants.QUEUE_PART].join(":");
  }

  /**
   * Key for a batch's items hash.
   * Maps item index to the serialized BatchItem payload.
   */
  batchItemsKey(batchId: string): string {
    return [constants.BATCH_PART, batchId, constants.ITEMS_PART].join(":");
  }

  /**
   * Key for a batch's metadata.
   * Stores serialized BatchMeta.
   */
  batchMetaKey(batchId: string): string {
    return [constants.BATCH_PART, batchId, constants.META_PART].join(":");
  }

  /**
   * Key for a batch's successful runs list.
   * Contains friendly run IDs in order of creation.
   */
  batchRunsKey(batchId: string): string {
    return [constants.BATCH_PART, batchId, constants.RUNS_PART].join(":");
  }

  /**
   * Key for a batch's failures list.
   * Contains serialized BatchItemFailure records.
   */
  batchFailuresKey(batchId: string): string {
    return [constants.BATCH_PART, batchId, constants.FAILURES_PART].join(":");
  }

  /**
   * Create a master queue member value from envId and batchId.
   * Format: "{envId}:{batchId}"
   */
  masterQueueMember(envId: string, batchId: string): string {
    return `${envId}:${batchId}`;
  }

  /**
   * Parse a master queue member to extract envId and batchId.
   */
  parseMasterQueueMember(member: string): { envId: string; batchId: string } {
    const colonIndex = member.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(`Invalid master queue member format: ${member}`);
    }
    return {
      envId: member.substring(0, colonIndex),
      batchId: member.substring(colonIndex + 1),
    };
  }

  /**
   * Extract batch ID from a batch-related key.
   */
  batchIdFromKey(key: string): string {
    // Keys are in format: batch:{batchId}:...
    const parts = key.split(":");
    if (parts.length >= 2 && parts[0] === constants.BATCH_PART) {
      return parts[1];
    }
    throw new Error(`Invalid batch key format: ${key}`);
  }
}

