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
  }

  private minPass(): number {
    let min = Infinity;
    for (const v of this.pass.values()) min = Math.min(min, v);
    return Number.isFinite(min) ? min : 0;
  }

  private passOf(groupId: GroupId): number {
    const existing = this.pass.get(groupId);
    if (existing !== undefined) return existing;
    const seeded = this.minPass();
    this.pass.set(groupId, seeded);
    return seeded;
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    _consumerId: string
  ): Promise<EnvQueues[]> {
    const active = await this.reader.readActiveQueues(parentQueue);
    if (active.length === 0) return [];

    // Seed any new groups at the current minimum pass before ordering.
    for (const a of active) this.passOf(a.groupId);

    return buildEnvQueues(
      active,
      (a, b) => (this.pass.get(a.groupId) ?? 0) - (this.pass.get(b.groupId) ?? 0)
    );
  }

  onServiced(descriptor: QueueDescriptor): void {
    const g = groupIdFromQueueName(descriptor.queue);
    this.pass.set(g, this.passOf(g) + this.stride1 / this.weight(g));
  }
}
