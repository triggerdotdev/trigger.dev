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
 * Stride scheduling: deterministic integer virtual-time WFQ. Each group has a
 * stride = stride1 / weight and a pass counter; the lowest pass is served next,
 * and servicing advances that group's pass by its stride. A newly active group
 * starts at the current minimum pass, so it neither hoards credit nor jumps the
 * queue (the classic late-arrival guard).
 */
export class StrideStrategy implements SpikeSelectionStrategy {
  readonly name = "stride";

  private readonly reader: SpikeQueueReader;
  private readonly weight: WeightFn;
  private readonly stride1: number;
  private pass = new Map<GroupId, number>();
  private floor = 0;

  constructor(opts: {
    redis: Redis;
    keys: RunQueueKeyProducer;
    weight?: WeightFn;
    stride1?: number;
  }) {
    this.reader = new SpikeQueueReader(opts.redis, opts.keys);
    this.weight = opts.weight ?? defaultWeight;
    this.stride1 = opts.stride1 ?? 1_000_000;
  }

  reset(): void {
    this.pass = new Map();
    this.floor = 0;
  }

  // Effective pass: an over-served group keeps its high pass, but a new or
  // returned-from-idle group is pulled up to the monotonic floor so it cannot
  // monopolise service with a stale low counter.
  private passOf(groupId: GroupId): number {
    return Math.max(this.pass.get(groupId) ?? this.floor, this.floor);
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    _consumerId: string
  ): Promise<EnvQueues[]> {
    const active = await this.reader.readActiveQueues(parentQueue);
    if (active.length === 0) return [];

    const activeGroups = new Set(active.map((a) => a.groupId));
    let min = Infinity;
    for (const g of activeGroups) min = Math.min(min, this.pass.get(g) ?? this.floor);
    if (Number.isFinite(min)) this.floor = Math.max(this.floor, min);

    return buildEnvQueues(active, (a, b) => this.passOf(a.groupId) - this.passOf(b.groupId));
  }

  onServiced(descriptor: QueueDescriptor): void {
    const g = groupIdFromQueueName(descriptor.queue);
    this.pass.set(g, this.passOf(g) + this.stride1 / this.weight(g));
  }
}
