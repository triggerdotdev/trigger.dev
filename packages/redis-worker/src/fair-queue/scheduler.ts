import type { FairScheduler, SchedulerContext, TenantQueues, QueueDescriptor } from "./types.js";

/**
 * Re-export scheduler types for convenience.
 */
export type { FairScheduler, SchedulerContext, TenantQueues };

/**
 * Base class for scheduler implementations.
 * Provides common utilities and default implementations.
 */
export abstract class BaseScheduler implements FairScheduler {
  /**
   * Select queues for processing from a master queue shard.
   * Must be implemented by subclasses.
   */
  abstract selectQueues(
    masterQueueShard: string,
    consumerId: string,
    context: SchedulerContext
  ): Promise<TenantQueues[]>;

  /**
   * Called after processing a message to update scheduler state.
   * Default implementation does nothing.
   */
  async recordProcessed(_tenantId: string, _queueId: string): Promise<void> {
    // Default: no state tracking
  }

  /**
   * Initialize the scheduler.
   * Default implementation does nothing.
   */
  async initialize(): Promise<void> {
    // Default: no initialization needed
  }

  /**
   * Cleanup scheduler resources.
   * Default implementation does nothing.
   */
  async close(): Promise<void> {
    // Default: no cleanup needed
  }

  /**
   * Helper to group queues by tenant.
   */
  protected groupQueuesByTenant(
    queues: Array<{ queueId: string; tenantId: string }>
  ): Map<string, string[]> {
    const grouped = new Map<string, string[]>();

    for (const { queueId, tenantId } of queues) {
      const existing = grouped.get(tenantId) ?? [];
      existing.push(queueId);
      grouped.set(tenantId, existing);
    }

    return grouped;
  }

  /**
   * Helper to convert grouped queues to TenantQueues array.
   */
  protected toTenantQueuesArray(grouped: Map<string, string[]>): TenantQueues[] {
    return Array.from(grouped.entries()).map(([tenantId, queues]) => ({
      tenantId,
      queues,
    }));
  }

  /**
   * Helper to filter out tenants at capacity.
   */
  protected async filterAtCapacity(
    tenants: TenantQueues[],
    context: SchedulerContext,
    groupName: string = "tenant"
  ): Promise<TenantQueues[]> {
    const filtered: TenantQueues[] = [];

    for (const tenant of tenants) {
      const isAtCapacity = await context.isAtCapacity(groupName, tenant.tenantId);
      if (!isAtCapacity) {
        filtered.push(tenant);
      }
    }

    return filtered;
  }
}

/**
 * Simple noop scheduler that returns empty results.
 * Useful for testing or disabling scheduling.
 */
export class NoopScheduler extends BaseScheduler {
  async selectQueues(
    _masterQueueShard: string,
    _consumerId: string,
    _context: SchedulerContext
  ): Promise<TenantQueues[]> {
    return [];
  }
}

