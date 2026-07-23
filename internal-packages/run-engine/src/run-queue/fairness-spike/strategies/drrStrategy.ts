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
 * Deficit round robin. A rotating cursor points at the group currently being
 * served. When the cursor lands on a group its deficit is topped up by
 * `quantum * weight`; the group keeps winning selection (and spending one unit
 * of deficit per serve) until its deficit falls below the unit head cost, then
 * the cursor advances. A 3x-weight group therefore serves ~3 runs per turn.
 */
export class DrrStrategy implements SpikeSelectionStrategy {
  readonly name = "drr";

  private readonly reader: SpikeQueueReader;
  private readonly weight: WeightFn;
  private readonly quantum: number;
  private deficit = new Map<GroupId, number>();
  private ring: GroupId[] = [];
  private cursor = 0;

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
    this.deficit = new Map();
    this.ring = [];
    this.cursor = 0;
  }

  async distributeFairQueuesFromParentQueue(
    parentQueue: string,
    _consumerId: string
  ): Promise<EnvQueues[]> {
    const active = await this.reader.readActiveQueues(parentQueue);
    if (active.length === 0) return [];

    const activeGroups = new Set(active.map((a) => a.groupId));
    for (const g of activeGroups) if (!this.ring.includes(g)) this.ring.push(g);
    this.ring = this.ring.filter((g) => activeGroups.has(g));
    if (this.ring.length === 0) return [];
    if (this.cursor >= this.ring.length) this.cursor = 0;

    // Find the group whose turn it is: top up deficits as the cursor passes
    // until a group has enough to serve.
    let winner = this.ring[this.cursor];
    for (let steps = 0; steps < this.ring.length; steps++) {
      const g = this.ring[this.cursor];
      if ((this.deficit.get(g) ?? 0) < 1) {
        this.deficit.set(g, (this.deficit.get(g) ?? 0) + this.quantum * this.weight(g));
      }
      if ((this.deficit.get(g) ?? 0) >= 1) {
        winner = g;
        break;
      }
      this.cursor = (this.cursor + 1) % this.ring.length;
    }

    // Rank: winner first, then the rest in ring order from the cursor.
    const rank = new Map<GroupId, number>();
    rank.set(winner, -1);
    for (let i = 0; i < this.ring.length; i++) {
      const g = this.ring[(this.cursor + i) % this.ring.length];
      if (!rank.has(g)) rank.set(g, i);
    }

    return buildEnvQueues(
      active,
      (a, b) =>
        (rank.get(a.groupId) ?? this.ring.length) - (rank.get(b.groupId) ?? this.ring.length)
    );
  }

  onServiced(descriptor: QueueDescriptor): void {
    const g = groupIdFromQueueName(descriptor.queue);
    this.deficit.set(g, (this.deficit.get(g) ?? 0) - 1);
    if ((this.deficit.get(g) ?? 0) < 1) {
      const idx = this.ring.indexOf(g);
      if (idx !== -1) this.cursor = (idx + 1) % this.ring.length;
    }
  }
}
