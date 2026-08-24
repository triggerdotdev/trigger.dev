// Reaps snapshot keyspaces that no healthy path will ever clean up.
//
// Two rules, because neither can see what the other leaves behind:
//
//   1. The run is terminal in Postgres but its keyspace never got the completion expiry — a
//      terminal append whose TTL-set was lost. Applying the expiry now reaps it on the same
//      schedule a healthy terminal append would have.
//   2. The keyspace has no Postgres run row at all, and is older than a threshold — a crashed
//      birth. It is non-terminal so it carries no expiry, and it has no run row, so rule 1 can
//      never match it. Without this rule that leak has no bound.
//
// Nothing schedules this. The engine's worker is what has to run it, and run-store cannot reach the
// engine, so the wiring belongs to the ticket that owns production construction.
import { createRedisClient, type Redis, type RedisOptions } from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import type { TaskRunStatus } from "@trigger.dev/database";
import { snapshotKeys } from "./redisSnapshotStore.js";
import type { RunStore } from "./types.js";

/**
 * Mirrors the engine's `finalStatuses`. run-store cannot import from run-engine — the dependency
 * runs the other way — so the list is duplicated and a parity test in run-engine asserts the copy
 * stays equal to the original.
 */
export const FINAL_RUN_STATUSES: readonly TaskRunStatus[] = [
  "CANCELED",
  "INTERRUPTED",
  "COMPLETED_SUCCESSFULLY",
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
];

const FINAL = new Set<string>(FINAL_RUN_STATUSES);

/** Comfortably above run-creation latency, so a birth in flight is never mistaken for an orphan. */
const DEFAULT_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 1000;

export type SweepResult = {
  /** Keyspaces examined. */
  scanned: number;
  /** Rule 1: terminal runs whose keyspace was given the completion expiry. */
  expired: number;
  /** Rule 2: keyspaces with no run row, deleted. */
  deleted: number;
  /** Left alone: a live run, a young orphan, or a batch whose Postgres lookup failed. */
  skipped: number;
};

export type SnapshotOrphanSweeperOptions = {
  /**
   * The sweep opens its own connection rather than borrowing the store's, so a long scan can never
   * stall a hot-path client.
   */
  redisOptions: RedisOptions;
  /**
   * Resolved through the run store, not a raw client. Under the run-ops split a run row can live on
   * either database, and only the store knows which — a raw lookup would report a live run as an
   * orphan and delete its keyspace.
   */
  runStore: RunStore;
  completedTtlMs: number;
  orphanAgeMs?: number;
  keyPrefix?: string;
  logger?: Logger;
};

export class SnapshotOrphanSweeper {
  readonly #redis: Redis;
  readonly #runStore: RunStore;
  readonly #completedTtlMs: number;
  readonly #orphanAgeMs: number;
  readonly #prefix: string;
  readonly #logger: Logger;
  #quit?: Promise<void>;

  constructor(options: SnapshotOrphanSweeperOptions) {
    this.#logger = options.logger ?? new Logger("SnapshotOrphanSweeper", "debug");
    this.#runStore = options.runStore;
    this.#completedTtlMs = options.completedTtlMs;
    this.#orphanAgeMs = options.orphanAgeMs ?? DEFAULT_ORPHAN_AGE_MS;
    this.#prefix = options.keyPrefix ?? "snap:";
    this.#redis = createRedisClient(options.redisOptions, {
      onError: (error) => this.#logger.error("SnapshotOrphanSweeper redis client error", { error }),
    });
  }

  async quit(): Promise<void> {
    if (!this.#quit) {
      this.#quit = this.#redis.quit().then(
        () => undefined,
        () => undefined
      );
    }
    await this.#quit;
  }

  /**
   * One full pass over the keyspace. `dryRun` reports what it would do and changes nothing.
   */
  async sweep(opts?: { batchSize?: number; dryRun?: boolean }): Promise<SweepResult> {
    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    const dryRun = opts?.dryRun ?? false;
    const result: SweepResult = { scanned: 0, expired: 0, deleted: 0, skipped: 0 };

    let cursor = "0";
    do {
      // Match on the entry hash, not on `cur`. The append script writes `cur` only when the entry
      // is valid, so a keyspace whose entries are all invalid would never be discovered and would
      // leak with no expiry, which is the same unbounded leak rule 2 exists to close. `e` is
      // written by every append.
      const [next, keys] = await this.#redis.scan(
        cursor,
        "MATCH",
        `${this.#prefix}{*}:e`,
        "COUNT",
        batchSize
      );
      cursor = next;

      const runIds = [...new Set(keys.map((key) => this.#runIdFrom(key)).filter(isString))];
      if (runIds.length === 0) continue;

      await this.#sweepBatch(runIds, dryRun, result);
    } while (cursor !== "0");

    this.#logger.log("SnapshotOrphanSweeper pass complete", { ...result, dryRun });
    return result;
  }

  async #sweepBatch(runIds: string[], dryRun: boolean, result: SweepResult): Promise<void> {
    result.scanned += runIds.length;

    let rows: Map<string, { status: TaskRunStatus }>;
    try {
      rows = (await this.#runStore.findRunsByIds(runIds, {
        select: { id: true, status: true },
      })) as unknown as Map<string, { status: TaskRunStatus }>;
    } catch (error) {
      // Never reap on an unknown answer. A lookup that failed says nothing about whether the run
      // exists, and rule 2 deletes a whole keyspace.
      this.#logger.error("SnapshotOrphanSweeper skipped a batch after a failed run lookup", {
        count: runIds.length,
        error,
      });
      result.skipped += runIds.length;
      return;
    }

    for (const runId of runIds) {
      const run = rows.get(runId);

      if (!run) {
        await this.#applyRuleTwo(runId, dryRun, result);
        continue;
      }

      if (!FINAL.has(run.status)) {
        // A live run. A SUSPENDED run can legitimately wait for weeks, so this is never touched.
        result.skipped += 1;
        continue;
      }

      await this.#applyRuleOne(runId, dryRun, result);
    }
  }

  /** Rule 1: a terminal run whose keyspace never received the completion expiry. */
  async #applyRuleOne(runId: string, dryRun: boolean, result: SweepResult): Promise<void> {
    const keys = await this.#allKeys(runId);
    if (keys.length === 0) {
      result.skipped += 1;
      return;
    }

    const ttls = await Promise.all(keys.map((key) => this.#redis.pttl(key)));
    // -1 is "exists, no expiry". Anything already counting down was set by a healthy append.
    if (!ttls.some((ttl) => ttl === -1)) {
      result.skipped += 1;
      return;
    }

    if (!dryRun) {
      const pipeline = this.#redis.pipeline();
      for (const key of keys) {
        pipeline.pexpire(key, this.#completedTtlMs);
      }
      await pipeline.exec();
    }

    result.expired += 1;
  }

  /** Rule 2: a keyspace with no run row at all, past the age threshold. */
  async #applyRuleTwo(runId: string, dryRun: boolean, result: SweepResult): Promise<void> {
    const keys = await this.#allKeys(runId);
    if (keys.length === 0) {
      result.skipped += 1;
      return;
    }

    const age = await this.#newestEntryAgeMs(runId);
    if (age === undefined || age < this.#orphanAgeMs) {
      // Either the keyspace carries no readable timestamp, or a birth may still be in flight.
      result.skipped += 1;
      return;
    }

    if (!dryRun) {
      await this.#redis.del(...keys);
    }

    result.deleted += 1;
  }

  /**
   * Every key for one run: the four core keys plus each wait-cycle key.
   *
   * The cycle keys are enumerated from the `c` high-water field on the seq hash, which the append
   * script mints densely with HINCRBY, so 1..high covers every wp key that was ever written. This
   * is the same source the store's own terminal-expiry loop uses.
   *
   * It deliberately does NOT use `KEYS`. That command iterates the whole database and blocks while
   * it does, and a hash tag routes a key without scoping the scan, so one sweep pass over a batch
   * would issue a full keyspace scan per run.
   *
   * The trade-off: if the seq hash is evicted while a wp key survives, `high` reads 0 and that
   * orphaned cycle key is left behind. That is the right way to be wrong here. Leaving one small
   * key costs bytes, where scanning the keyspace to find it costs every hot-path client latency on
   * every pass.
   */
  async #allKeys(runId: string): Promise<string[]> {
    const core = snapshotKeys(runId);

    const high = Number((await this.#redis.hget(core.seq, "c")) ?? "0");
    const cycles: string[] = [];
    for (let n = 1; n <= high; n++) {
      cycles.push(`${this.#prefix}{${runId}}:wp:${n}`);
    }

    const candidates = [core.e, core.idx, core.cur, core.seq, ...cycles];

    // One round trip for the whole set, rather than one per candidate.
    const pipeline = this.#redis.pipeline();
    for (const key of candidates) {
      pipeline.exists(key);
    }
    const replies = await pipeline.exec();

    return candidates.filter((_key, index) => replies?.[index]?.[1] === 1);
  }

  /**
   * Age of the newest entry, so a keyspace still being written to is never treated as an orphan.
   * The newest is the right end: an old first entry says nothing about whether the run is dead.
   */
  async #newestEntryAgeMs(runId: string): Promise<number | undefined> {
    const core = snapshotKeys(runId);

    const newest = await this.#redis.zrevrange(core.idx, 0, 0);
    const id = newest[0];

    const raw = id
      ? await this.#redis.hget(core.e, id)
      : // The index holds valid entries only, so an all-invalid keyspace has an empty index. Fall
        // back to the newest instant in the entry hash, or that keyspace is never old enough to
        // reap and the leak survives the scan fix above.
        await this.#newestRawFromEntries(core.e);

    if (!raw) return undefined;

    try {
      const createdAt = (JSON.parse(raw) as { createdAt?: string }).createdAt;
      if (!createdAt) return undefined;
      const parsed = Date.parse(createdAt);
      return Number.isNaN(parsed) ? undefined : Date.now() - parsed;
    } catch {
      return undefined;
    }
  }

  /**
   * The newest entry document in the hash, by its own createdAt. Only reached for a keyspace with
   * no index, which is rare, so the whole-hash read is acceptable where it would not be on the
   * indexed path.
   */
  async #newestRawFromEntries(eKey: string): Promise<string | undefined> {
    const all = await this.#redis.hgetall(eKey);
    let newestRaw: string | undefined;
    let newestAt = -Infinity;

    for (const [field, raw] of Object.entries(all)) {
      // Sidecar fields hang off the entry ids as `<id>#s` and `<id>#c`; skip them.
      if (field.includes("#")) continue;
      try {
        const at = Date.parse((JSON.parse(raw) as { createdAt?: string }).createdAt ?? "");
        if (!Number.isNaN(at) && at > newestAt) {
          newestAt = at;
          newestRaw = raw;
        }
      } catch {
        continue;
      }
    }

    return newestRaw;
  }

  #runIdFrom(key: string): string | undefined {
    const open = key.indexOf("{");
    const close = key.indexOf("}", open + 1);
    if (open === -1 || close === -1 || close === open + 1) return undefined;
    return key.slice(open + 1, close);
  }
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
