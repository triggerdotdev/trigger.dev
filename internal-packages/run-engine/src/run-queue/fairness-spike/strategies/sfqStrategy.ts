import type { Redis } from "@internal/redis";
import type { EnvQueues, QueueDescriptor, RunQueueKeyProducer } from "../../types.js";
import {
  SpikeQueueReader,
  defaultWeight,
  groupIdFromQueueName,
  type GroupId,
  type SpikeSelectionStrategy,
  type WeightFn,
} from "../types.js";
import { buildEnvQueues } from "./base.js";

/**
 * Start-time fair queueing (SFQ), the start-tag form of WFQ.
 *
 * Each group carries a virtual clock = accumulated service scaled by 1/weight.
 * On selection a group's start tag is max(its clock, the system floor); the
 * floor is the min clock over active groups (the CFS `min_vruntime` analogue),
 * so a newly active or long-idle group jumps to the floor rather than hoarding
 * credit or being buried. Queues are ordered by ascending start tag.
 *
 * Note: this is plain start-time WFQ, not EEVDF. An earlier version carried an
 * eligibility term, but with one clock per group the smallest-start-tag group is
 * always the eligible one, so the term never changed the ordering; it was dropped.
 */
export class SfqStrategy implements SpikeSelectionStrategy {
  readonly name = "sfq";

  private readonly reader: SpikeQueueReader;
  private readonly weight: WeightFn;
  private readonly quantum: number;
  private virtualClock = new Map<GroupId, number>();
  private floor = 0;

  constructor(opts: {
    redis: Redis;
    keys: RunQueueKeyProducer;
    weight?: WeightFn;
    quantum?: number;
  }) {
    this.reader = new SpikeQueueReader(opts.redis, opts.keys);
    this.weight = opts.weight ?? defaultWeight;
    this.quantum = opts.quantum ?? 1;
  }

  reset(): void {
    this.virtualClock = new Map();
    this.floor = 0;
  }

  private clockOf(groupId: GroupId): number {
    return this.virtualClock.get(groupId) ?? this.floor;
  }

  private startTag(groupId: GroupId): number {
    return Math.max(this.clockOf(groupId), this.floor);
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    _consumerId: string
  ): Promise<EnvQueues[]> {
    const active = await this.reader.readActiveQueues(parentQueue);
    if (active.length === 0) return [];

    // Advance the system floor like CFS min_vruntime: it is the min clock over
    // active groups but is monotonic non-decreasing, so a group that went idle
    // and returns with a stale low clock is pulled up to the floor (via
    // startTag) instead of collapsing the floor and monopolising service.
    const activeGroups = new Set(active.map((a) => a.groupId));
    let min = Infinity;
    for (const g of activeGroups) min = Math.min(min, this.clockOf(g));
    if (Number.isFinite(min)) this.floor = Math.max(this.floor, min);

    return buildEnvQueues(active, (a, b) => this.startTag(a.groupId) - this.startTag(b.groupId));
  }

  onServiced(descriptor: QueueDescriptor): void {
    const g = groupIdFromQueueName(descriptor.queue);
    const next = this.startTag(g) + this.quantum / this.weight(g);
    this.virtualClock.set(g, next);
  }
}
