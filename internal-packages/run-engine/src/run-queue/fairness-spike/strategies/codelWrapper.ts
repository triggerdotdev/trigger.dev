import type { Redis } from "@internal/redis";
import type { EnvQueues, QueueDescriptor, RunQueueKeyProducer } from "../../types.js";
import {
  SpikeQueueReader,
  groupIdFromQueueName,
  type GroupId,
  type SpikeSelectionStrategy,
} from "../types.js";

/**
 * CoDel-style staleness controller. Not a selector on its own: it wraps a base
 * selector and only intervenes when a group's minimum sojourn (time its oldest
 * run has waited) stays above `targetMs` for a full `intervalMs`. Such groups
 * are hoisted ahead of the base ordering until their sojourn recovers. This is
 * the anti-staleness safety net, measuring time-in-queue rather than depth.
 */
export class CodelWrapper implements SpikeSelectionStrategy {
  readonly name: string;

  private readonly base: SpikeSelectionStrategy;
  private readonly reader: SpikeQueueReader;
  private readonly targetMs: number;
  private readonly intervalMs: number;
  private currentNow = 0;
  private firstAboveTargetAt = new Map<GroupId, number>();

  constructor(opts: {
    base: SpikeSelectionStrategy;
    redis: Redis;
    keys: RunQueueKeyProducer;
    targetMs: number;
    intervalMs: number;
  }) {
    this.base = opts.base;
    this.reader = new SpikeQueueReader(opts.redis, opts.keys);
    this.targetMs = opts.targetMs;
    this.intervalMs = opts.intervalMs;
    this.name = `codel(${opts.base.name})`;
  }

  reset(): void {
    this.firstAboveTargetAt = new Map();
    this.currentNow = 0;
    this.base.reset?.();
  }

  setClock(now: number): void {
    this.currentNow = now;
    this.base.setClock?.(now);
  }

  private escalatingGroups(minHeadByGroup: Map<GroupId, number>): Set<GroupId> {
    const escalating = new Set<GroupId>();
    const seen = new Set<GroupId>();

    for (const [group, minHead] of minHeadByGroup) {
      seen.add(group);
      const sojourn = this.currentNow - minHead;
      if (sojourn > this.targetMs) {
        const since = this.firstAboveTargetAt.get(group) ?? this.currentNow;
        this.firstAboveTargetAt.set(group, since);
        if (this.currentNow - since >= this.intervalMs) escalating.add(group);
      } else {
        this.firstAboveTargetAt.delete(group);
      }
    }

    // forget groups that are no longer active
    for (const g of [...this.firstAboveTargetAt.keys()]) {
      if (!seen.has(g)) this.firstAboveTargetAt.delete(g);
    }

    return escalating;
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    consumerId: string
  ): Promise<EnvQueues[]> {
    const [baseOrder, active] = await Promise.all([
      this.base.distributeFairQueuesFromParentQueue(parentQueue, consumerId),
      this.reader.readActiveQueues(parentQueue),
    ]);

    const groupOfQueue = new Map<string, GroupId>();
    const minHeadByGroup = new Map<GroupId, number>();
    for (const a of active) {
      groupOfQueue.set(a.queue, a.groupId);
      const head = a.headScore ?? Number.POSITIVE_INFINITY;
      const cur = minHeadByGroup.get(a.groupId);
      if (cur === undefined || head < cur) minHeadByGroup.set(a.groupId, head);
    }

    const escalating = this.escalatingGroups(minHeadByGroup);
    if (escalating.size === 0) return baseOrder;

    // Hoist escalating groups' queues to the front of each env, preserving the
    // base order within the hoisted and non-hoisted partitions.
    return baseOrder.map((env) => {
      const hot: string[] = [];
      const cold: string[] = [];
      for (const q of env.queues) {
        const g = groupOfQueue.get(q);
        if (g !== undefined && escalating.has(g)) hot.push(q);
        else cold.push(q);
      }
      return { envId: env.envId, queues: [...hot, ...cold] };
    });
  }

  onServiced(descriptor: QueueDescriptor, now: number): void | Promise<void> {
    return this.base.onServiced(descriptor, now);
  }
}
