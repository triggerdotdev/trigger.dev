import type { Redis } from "@internal/redis";
import type {
  EnvDescriptor,
  QueueDescriptor,
  RunQueueKeyProducer,
  RunQueueSelectionStrategy,
} from "../types.js";

/**
 * Fairness-spike shared types. Throwaway: this whole directory is a bench for
 * ranking fair-queueing disciplines and ships nothing.
 *
 * Grain = the base queue name (see the plan's Discovery note for why not the
 * concurrency key). A "group" is one distinct base queue in one environment.
 */

export type GroupId = string;

export type WeightFn = (groupId: GroupId) => number;

export const defaultWeight: WeightFn = () => 1;

/**
 * A "group" (tenant) can own more than one base queue. We encode the tenant in
 * the queue name as `${tenant}~${index}` and recover it here. This is what lets
 * the spike reproduce the #2617 dynamic at the base-queue grain: a heavy tenant
 * owning many queues would out-select light tenants under any per-queue
 * discipline that is blind to tenant identity (the current baseline), while a
 * tenant-keyed discipline stays fair.
 */
export const GROUP_SEPARATOR = "~";

export function groupIdFromQueueName(queueName: string): GroupId {
  const idx = queueName.indexOf(GROUP_SEPARATOR);
  return idx === -1 ? queueName : queueName.slice(0, idx);
}

/**
 * A selection strategy under test. Extends the real RunQueue interface with an
 * `onServiced` hook: the strategy interface is selection-only and is never told
 * which queue actually got dequeued, so stateful disciplines (virtual clock,
 * deficit, pass counter) need the driver to feed serviced descriptors back.
 * In production that advance would live in the ack/dequeue Lua.
 */
export interface SpikeSelectionStrategy extends RunQueueSelectionStrategy {
  readonly name: string;
  onServiced(descriptor: QueueDescriptor, now: number): void | Promise<void>;
  reset?(): void | Promise<void>;
}

export type ActiveQueue = {
  queue: string;
  env: EnvDescriptor;
  groupId: GroupId;
  headScore: number | undefined;
};

/**
 * Reads the current set of active base queues under a parent (master) queue,
 * with each queue's head-message score (its oldest enqueue timestamp). The
 * candidate selectors order these.
 */
export class SpikeQueueReader {
  constructor(
    private readonly redis: Redis,
    private readonly keys: RunQueueKeyProducer
  ) {}

  async readActiveQueues(parentQueue: string): Promise<ActiveQueue[]> {
    const queues = await this.redis.zrange(parentQueue, 0, -1);
    const out: ActiveQueue[] = [];

    for (const queue of queues) {
      // Grain is base queues; a CK wildcard here means a workload leaked a
      // concurrency key, which the spike does not use.
      if (this.keys.isCkWildcard(queue)) continue;

      const head = await this.redis.zrange(queue, 0, 0, "WITHSCORES");
      if (head.length < 2) continue;

      const d = this.keys.descriptorFromQueue(queue);
      out.push({
        queue,
        env: { orgId: d.orgId, projectId: d.projectId, envId: d.envId },
        groupId: groupIdFromQueueName(d.queue),
        headScore: Number(head[1]),
      });
    }

    return out;
  }
}
