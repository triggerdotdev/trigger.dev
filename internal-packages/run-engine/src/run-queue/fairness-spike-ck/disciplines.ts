import type { ActiveCk } from "./ckReader.js";

/**
 * Fair-queueing disciplines keyed by concurrency key. Each returns an order over
 * the active CK-queues (best priority first); the driver writes that order into
 * ckIndex so the real dequeue Lua follows it. Ports the base-queue spike's vetted
 * logic (monotonic virtual-time floor, deficit round robin, stride) with all CKs
 * at equal weight, since concurrency keys carry no configured weight in
 * production.
 */
export interface CkDiscipline {
  readonly name: string;
  /** false for baseline: leave ckIndex scores as the Lua maintains them (age order) */
  readonly rescore: boolean;
  order(active: ActiveCk[], now: number): string[];
  onServiced(concurrencyKey: string): void;
  reset(): void;
}

function byPriority(active: ActiveCk[], priorityOf: (ck: string) => number): string[] {
  return [...active]
    .sort(
      (a, b) =>
        priorityOf(a.concurrencyKey) - priorityOf(b.concurrencyKey) ||
        a.headScore - b.headScore ||
        (a.ckQueue < b.ckQueue ? -1 : 1)
    )
    .map((a) => a.ckQueue);
}

/** Production behaviour: oldest head first. No rescore. */
export class BaselineCk implements CkDiscipline {
  readonly name = "baseline";
  readonly rescore = false;
  order(active: ActiveCk[]): string[] {
    return byPriority(active, () => 0); // headScore tiebreak gives age order
  }
  onServiced(): void {}
  reset(): void {}
}

/** Start-time fair queueing with a monotonic floor (CFS min_vruntime analogue). */
export class SfqCk implements CkDiscipline {
  readonly name = "sfq";
  readonly rescore = true;
  private clock = new Map<string, number>();
  private floor = 0;
  private readonly quantum: number;
  constructor(quantum = 1) {
    this.quantum = quantum;
  }
  reset(): void {
    this.clock = new Map();
    this.floor = 0;
  }
  private startTag(ck: string): number {
    return Math.max(this.clock.get(ck) ?? this.floor, this.floor);
  }
  order(active: ActiveCk[]): string[] {
    let min = Infinity;
    for (const a of active) min = Math.min(min, this.clock.get(a.concurrencyKey) ?? this.floor);
    if (Number.isFinite(min)) this.floor = Math.max(this.floor, min);
    return byPriority(active, (ck) => this.startTag(ck));
  }
  onServiced(ck: string): void {
    this.clock.set(ck, this.startTag(ck) + this.quantum);
  }
}

/** Deficit round robin. */
export class DrrCk implements CkDiscipline {
  readonly name = "drr";
  readonly rescore = true;
  private deficit = new Map<string, number>();
  private ring: string[] = [];
  private cursor = 0;
  private readonly quantum: number;
  constructor(quantum = 1) {
    this.quantum = quantum;
  }
  reset(): void {
    this.deficit = new Map();
    this.ring = [];
    this.cursor = 0;
  }
  order(active: ActiveCk[]): string[] {
    const activeKeys = new Set(active.map((a) => a.concurrencyKey));
    for (const k of activeKeys) if (!this.ring.includes(k)) this.ring.push(k);
    this.ring = this.ring.filter((k) => activeKeys.has(k));
    if (this.ring.length === 0) return [];
    if (this.cursor >= this.ring.length) this.cursor = 0;

    let winner = this.ring[this.cursor];
    for (let steps = 0; steps < this.ring.length; steps++) {
      const k = this.ring[this.cursor];
      if ((this.deficit.get(k) ?? 0) < 1) {
        this.deficit.set(k, (this.deficit.get(k) ?? 0) + this.quantum);
      }
      if ((this.deficit.get(k) ?? 0) >= 1) {
        winner = k;
        break;
      }
      this.cursor = (this.cursor + 1) % this.ring.length;
    }

    const rank = new Map<string, number>();
    rank.set(winner, -1);
    for (let i = 0; i < this.ring.length; i++) {
      const k = this.ring[(this.cursor + i) % this.ring.length];
      if (!rank.has(k)) rank.set(k, i);
    }
    return byPriority(active, (ck) => rank.get(ck) ?? this.ring.length);
  }
  onServiced(ck: string): void {
    this.deficit.set(ck, (this.deficit.get(ck) ?? 0) - 1);
    if ((this.deficit.get(ck) ?? 0) < 1) {
      const idx = this.ring.indexOf(ck);
      if (idx !== -1) this.cursor = (idx + 1) % this.ring.length;
    }
  }
}

/** Stride scheduling with a monotonic pass floor. */
export class StrideCk implements CkDiscipline {
  readonly name = "stride";
  readonly rescore = true;
  private pass = new Map<string, number>();
  private floor = 0;
  private readonly stride1: number;
  constructor(stride1 = 1_000_000) {
    this.stride1 = stride1;
  }
  reset(): void {
    this.pass = new Map();
    this.floor = 0;
  }
  private passOf(ck: string): number {
    return Math.max(this.pass.get(ck) ?? this.floor, this.floor);
  }
  order(active: ActiveCk[]): string[] {
    let min = Infinity;
    for (const a of active) min = Math.min(min, this.pass.get(a.concurrencyKey) ?? this.floor);
    if (Number.isFinite(min)) this.floor = Math.max(this.floor, min);
    return byPriority(active, (ck) => this.passOf(ck));
  }
  onServiced(ck: string): void {
    this.pass.set(ck, this.passOf(ck) + this.stride1);
  }
}

/** CoDel-style staleness wrapper: hoists keys whose sojourn stays above target. */
export class CodelCk implements CkDiscipline {
  readonly name: string;
  readonly rescore = true;
  private firstAbove = new Map<string, number>();
  constructor(
    private readonly base: CkDiscipline,
    private readonly targetMs: number,
    private readonly intervalMs: number
  ) {
    this.name = `codel(${base.name})`;
  }
  reset(): void {
    this.firstAbove = new Map();
    this.base.reset();
  }
  order(active: ActiveCk[], now: number): string[] {
    const baseOrder = this.base.order(active, now);
    const ckToKey = new Map(active.map((a) => [a.ckQueue, a.concurrencyKey]));
    const minHead = new Map<string, number>();
    for (const a of active) {
      const cur = minHead.get(a.concurrencyKey);
      if (cur === undefined || a.headScore < cur) minHead.set(a.concurrencyKey, a.headScore);
    }
    const escalating = new Set<string>();
    const seen = new Set<string>();
    for (const [ck, head] of minHead) {
      seen.add(ck);
      if (now - head > this.targetMs) {
        const since = this.firstAbove.get(ck) ?? now;
        this.firstAbove.set(ck, since);
        if (now - since >= this.intervalMs) escalating.add(ck);
      } else {
        this.firstAbove.delete(ck);
      }
    }
    for (const k of [...this.firstAbove.keys()]) if (!seen.has(k)) this.firstAbove.delete(k);
    if (escalating.size === 0) return baseOrder;
    const hot: string[] = [];
    const cold: string[] = [];
    for (const ckQueue of baseOrder) {
      const ck = ckToKey.get(ckQueue);
      if (ck !== undefined && escalating.has(ck)) hot.push(ckQueue);
      else cold.push(ckQueue);
    }
    return [...hot, ...cold];
  }
  onServiced(ck: string): void {
    this.base.onServiced(ck);
  }
}
