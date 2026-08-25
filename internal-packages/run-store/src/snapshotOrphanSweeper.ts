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
import {
  Cluster,
  createRedisClient,
  type Redis,
  type RedisClient,
  type RedisOptions,
} from "@internal/redis";
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

/**
 * The keyspace prefix, owned by `snapshotKeys` in the store rather than configurable here. A sweep
 * that could be pointed at a different prefix would be a fiction: the store writes `snap:` keys
 * unconditionally, so there is no other keyspace to point it at.
 */
const SNAPSHOT_KEYSPACE_PREFIX = "snap:";
const DEFAULT_BATCH_SIZE = 1000;

/**
 * How long a rule 2 candidate must have been marked before it may be deleted. It has to exceed the
 * interval between passes, or a candidate is never sighted twice and never converts.
 */
const DEFAULT_ORPHAN_CONFIRM_MS = 60 * 60 * 1000;

export type SweepResult = {
  /** Keyspaces examined. */
  scanned: number;
  /** Rule 1: terminal runs whose keyspace was given the completion expiry. */
  expired: number;
  /** Rule 2: keyspaces with no run row, deleted. */
  deleted: number;
  /** Left alone: a live run, a young orphan, or a batch whose Postgres lookup failed. */
  skipped: number;
  /**
   * Rule 2 candidates that were marked but not deleted, because deletion needs a second sighting
   * in a later pass. A number that never converts to `deleted` means the confirm window is longer
   * than the interval between passes, or the marker TTL is shorter than it.
   */
  pendingDeletion: number;
  /**
   * Connections the pass iterated: every master of a cluster, or 1 standalone. Reported because the
   * failure this component cannot tolerate is a false green, and a pass that covered one node of
   * six is indistinguishable from a complete one by any other field here. TRI-13453 gates the dial
   * on an observed sweep pass, so the observation has to carry its own coverage.
   */
  nodes: number;
  /** True when the pass stopped early on its deadline or abort signal, so coverage is incomplete. */
  partial: boolean;
};

/**
 * Exactly one of `redisOptions` or `client`, enforced by the type rather than a runtime check.
 * With `redisOptions` the sweep opens its OWN connection, which is the preferred shape: a long
 * scan can then never stall a hot-path client. `client` exists for a caller that has already built
 * a client and wants the sweep to use it; a borrowed client is left open by `quit()`.
 *
 * What the sweep needs is a connection of its OWN, not one it built itself. A caller pointing at a
 * cluster should build a SECOND, sweep-dedicated cluster client and pass it here: that keeps a long
 * scan off the hot path just as well as `redisOptions` does. Handing over the client the snapshot
 * store is using is the case to avoid.
 */
export type SnapshotOrphanSweeperConnection =
  | { client: RedisClient; redisOptions?: never }
  | { client?: never; redisOptions: RedisOptions };

export type SnapshotOrphanSweeperOptions = SnapshotOrphanSweeperConnection & {
  /**
   * Resolved through the run store, not a raw client. Under the run-ops split a run row can live on
   * either database, and only the store knows which — a raw lookup would report a live run as an
   * orphan and delete its keyspace.
   */
  runStore: RunStore;
  completedTtlMs: number;
  orphanAgeMs?: number;
  /**
   * How long a rule 2 candidate must stay marked before the sweep will delete it. Defaults to one
   * hour.
   *
   * Set it at or below the interval between passes, or the second sighting arrives too early to
   * count and every candidate needs three passes instead of two. It does NOT need to exceed the
   * interval; the constraint people reach for ("longer than the interval") is the wrong one and
   * only costs latency.
   *
   * There is no marker-lifetime constraint to satisfy alongside it. The marker is a field on the
   * run's `seq` hash, so it lives exactly as long as the keyspace it describes: it cannot expire
   * out from under a candidate that is still waiting for its second sighting, and it cannot outlive
   * a keyspace that was deleted.
   */
  confirmOrphanAfterMs?: number;
  logger?: Logger;
};

export class SnapshotOrphanSweeper {
  readonly #redis: RedisClient;
  /** Only a client this class opened may be closed by it. */
  readonly #ownsClient: boolean;
  readonly #runStore: RunStore;
  readonly #completedTtlMs: number;
  readonly #orphanAgeMs: number;
  readonly #confirmOrphanAfterMs: number;
  /**
   * The ioredis client-level prefix, which is NOT the keyspace prefix. ioredis prepends it to keys
   * for ordinary commands, but it does not prepend it to a SCAN MATCH pattern, and it does return
   * matched keys with it still attached. Unhandled, a prefixed client makes the sweep match nothing
   * and report a clean pass, which is the worst outcome for a safety net.
   */
  readonly #clientPrefix: string;
  readonly #logger: Logger;
  #quit?: Promise<void>;

  constructor(options: SnapshotOrphanSweeperOptions) {
    this.#logger = options.logger ?? new Logger("SnapshotOrphanSweeper", "debug");
    this.#runStore = options.runStore;
    this.#completedTtlMs = options.completedTtlMs;
    this.#orphanAgeMs = options.orphanAgeMs ?? DEFAULT_ORPHAN_AGE_MS;
    this.#confirmOrphanAfterMs = options.confirmOrphanAfterMs ?? DEFAULT_ORPHAN_CONFIRM_MS;
    this.#ownsClient = options.client === undefined;
    this.#redis =
      options.client ??
      createRedisClient(options.redisOptions, {
        onError: (error) =>
          this.#logger.error("SnapshotOrphanSweeper redis client error", { error }),
      });
    this.#clientPrefix = clientPrefixOf(this.#redis);
  }

  async quit(): Promise<void> {
    // A borrowed client belongs to the caller; closing it here would take down a connection the
    // snapshot store may still be using.
    if (!this.#ownsClient) return;
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
   *
   * `deadline` and `signal` let the caller stop a pass cleanly instead of having it killed
   * mid-cursor. The scheduler needs this: redis-worker moves a dequeued item's score to
   * `now + visibilityTimeoutMs` and nothing extends it, so a pass that outlives its timeout is
   * redelivered and runs concurrently with itself. A pass that stops inside its budget cannot.
   *
   * Whichever way it stops, `partial` comes back true. Reporting a truncated pass as a full one is
   * the same false green as under-scanning a cluster: TRI-13453 gates the dial on an OBSERVED
   * sweep pass, so the observation has to say how much of the keyspace it actually reached.
   */
  async sweep(opts?: {
    batchSize?: number;
    dryRun?: boolean;
    /** Epoch ms. The pass stops at the next batch boundary once passed. */
    deadline?: number;
    signal?: AbortSignal;
  }): Promise<SweepResult> {
    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    const dryRun = opts?.dryRun ?? false;
    const result: SweepResult = {
      scanned: 0,
      expired: 0,
      deleted: 0,
      skipped: 0,
      pendingDeletion: 0,
      nodes: 0,
      partial: false,
    };

    // Checked at batch boundaries only. Stopping mid-batch would leave a run half-acted-on, and a
    // batch is bounded work, so the boundary is both the safe and the timely place.
    const outOfBudget = () =>
      opts?.signal?.aborted === true ||
      (opts?.deadline !== undefined && Date.now() >= opts.deadline);

    // SCAN carries no key, so a cluster cannot route it: one connection iterates ONE node's
    // keyspace and then reports a completed cursor. A single-client sweep against a cluster would
    // therefore return a clean-looking result having examined roughly 1/N of the keyspace, and the
    // rest would leak with nothing to revisit it. Both rules are unbounded leaks when missed, so
    // the pass fans out over every master and only reports done when all of them are done.
    const nodes = this.#scanTargets();
    result.nodes = nodes.length;

    for (const node of nodes) {
      if (outOfBudget()) {
        result.partial = true;
        break;
      }

      let cursor = "0";
      do {
        // Match on the entry hash, not on `cur`. The append script writes `cur` only when the entry
        // is valid, so a keyspace whose entries are all invalid would never be discovered and would
        // leak with no expiry, which is the same unbounded leak rule 2 exists to close. `e` is
        // written by every append.
        const [next, keys] = await node.scan(
          cursor,
          "MATCH",
          `${this.#clientPrefix}${SNAPSHOT_KEYSPACE_PREFIX}{*}:e`,
          "COUNT",
          batchSize
        );
        cursor = next;

        const runIds = [...new Set(keys.map((key) => this.#runIdFrom(key)).filter(isString))];
        if (runIds.length === 0) continue;

        await this.#sweepBatch(runIds, dryRun, result);

        if (outOfBudget()) {
          // A cursor mid-iteration means this node is not finished, so the pass is not either.
          result.partial = true;
          break;
        }
      } while (cursor !== "0");

      if (result.partial) break;
    }

    this.#logger.log("SnapshotOrphanSweeper pass complete", { ...result, dryRun });
    return result;
  }

  #scanTargets(): Redis[] {
    return scanTargetsOf(this.#redis);
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

    // Every run that EXISTS clears its rule 2 marker, live ones included. It has to be every one,
    // not just the terminal ones: a keyspace marked by an incomplete lookup, then seen alive, then
    // missed again would otherwise present a mature marker on what is really a first sighting, and
    // the two-sighting rule would be gone exactly when it was needed. This costs one DEL per
    // existing run per pass, which is the price of the guard being sound rather than nearly sound.
    const present = runIds.filter((runId) => rows.has(runId));
    if (!dryRun && present.length > 0) {
      // Individual commands, never one pipeline: these keys span runs, so they span cluster slots.
      await Promise.all(present.map((runId) => this.#clearOrphanMarker(runId)));
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

  /**
   * Rule 2: a keyspace with no run row at all, past the age threshold.
   *
   * TWO SIGHTINGS ARE REQUIRED. The `catch` in #sweepBatch covers a lookup that THROWS, but it
   * cannot see a lookup that succeeds and is incomplete: a row that exists but did not come back
   * reads exactly like a run that never existed, and the response to that is deleting a live run's
   * execution state. `findRunsByIds` routes through RoutingRunStore.#findRunsByIdSet, which
   * partitions ids by residency and asks each store only for its own — and with no client passed it
   * reads each store's REPLICA. Both are sound today (id classification is authoritative for runs,
   * and replica lag is nowhere near the 24h age gate), but each is an assumption held somewhere
   * else in the codebase, not something this delete path can check.
   *
   * The asymmetry decides it: a false negative leaks keys, which is bounded and recoverable, while
   * a false positive destroys live state. So an absent row marks the keyspace and returns; only a
   * candidate still absent in a LATER pass is deleted. Any transient incomplete answer, whatever
   * its cause, has to occur twice across the confirm window to do damage.
   */
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

    const seqKey = snapshotKeys(runId).seq;
    const markedAtRaw = await this.#redis.hget(seqKey, ORPHAN_MARKER_FIELD);
    const markedAt = markedAtRaw === null ? undefined : Number(markedAtRaw);

    if (markedAt === undefined || Number.isNaN(markedAt)) {
      if (!dryRun) {
        // The TTL is a multiple of the confirm window so a candidate gets several chances to be
        // sighted again, while a marker left behind by a run that turned out to be alive cannot
        // linger long enough to pre-authorise a later deletion.
        // The field carries no TTL of its own; it lives and dies with the seq hash, which the
        // keyspace's own completion expiry already governs. That removes the marker-lifetime knob
        // whose derivation was wrong in the first place.
        await this.#redis.hset(seqKey, ORPHAN_MARKER_FIELD, String(Date.now()));
      }
      result.pendingDeletion += 1;
      return;
    }

    if (Date.now() - markedAt < this.#confirmOrphanAfterMs) {
      result.pendingDeletion += 1;
      return;
    }

    if (!dryRun) {
      // One slot: every key here carries the same `{runId}` hash tag. The marker is a field on
      // `seq`, which is in `keys`, so it goes with the keyspace rather than needing its own entry.
      await this.#redis.del(...keys);
    }

    result.deleted += 1;
  }

  /**
   * Clears a rule 2 marker for a keyspace whose run turned out to exist after all, so a later
   * genuine absence still needs its own two sightings rather than inheriting a stale one.
   *
   * Only called on a path that already found a run row, and only for terminal runs — a live run
   * never reaches rule 2, so it can never hold a marker, and charging every live keyspace a round
   * trip to prove that would cost more than the case is worth.
   */
  async #clearOrphanMarker(runId: string): Promise<void> {
    try {
      await this.#redis.hdel(snapshotKeys(runId).seq, ORPHAN_MARKER_FIELD);
    } catch {
      // Best effort. A marker that outlives its usefulness expires on its own TTL.
    }
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
      cycles.push(`${SNAPSHOT_KEYSPACE_PREFIX}{${runId}}:wp:${n}`);
    }

    const candidates = [core.e, core.idx, core.cur, core.seq, ...cycles];

    // One round trip for the whole set, rather than one per candidate. Cluster-safe: every key here
    // carries the same `{runId}` hash tag, so the whole pipeline lands in one slot on one node.
    // The same holds for the pexpire pipeline and the multi-key DEL above.
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

  /**
   * The run id is whatever sits inside the hash tag, so a client prefix on the returned key does not
   * need stripping: `engine:snap:{run_x}:e` and `snap:{run_x}:e` both yield `run_x`.
   */
  #runIdFrom(key: string): string | undefined {
    const open = key.indexOf("{");
    const close = key.indexOf("}", open + 1);
    if (open === -1 || close === -1 || close === open + 1) return undefined;
    return key.slice(open + 1, close);
  }
}

/**
 * Every connection a pass must iterate to cover the whole keyspace: each master of a cluster, or
 * the one standalone connection. Replicas are excluded — they hold the same keys as their master,
 * so scanning them would double-count and act on one keyspace twice.
 *
 * Module-level and exported so the fan-out decision can be pinned on its own. It is the whole of
 * the defect this guards against: everything the sweep does AFTER the scan is key-addressed and a
 * cluster client routes it correctly without help, so the node list is the only place a cluster
 * can silently cost the pass coverage.
 *
 * Resolved per pass, never cached: cluster topology changes under failover and resharding, and a
 * stale node list is the same silent under-scan this exists to prevent.
 */

/**
 * Rule 2's "seen absent once" marker is a FIELD on the run's `seq` hash, not a key of its own.
 *
 * As a separate key its removal depended on the deleting call site remembering to append it to the
 * DEL, which is the kind of contract a later edit breaks with no test noticing: a marker outliving
 * its keyspace would let a recreated keyspace be deleted on what is really a first sighting. `seq`
 * is already in `#allKeys`, so as a field the marker cannot outlive the keyspace at all.
 */
const ORPHAN_MARKER_FIELD = "orph";

export function scanTargetsOf(client: RedisClient): Redis[] {
  return client instanceof Cluster ? client.nodes("master") : [client];
}

/**
 * The ioredis client-level prefix for either endpoint shape. On a Cluster it lives on the nested
 * `redisOptions`, not on the top-level options, and reading the wrong one yields "" — which makes
 * every SCAN MATCH miss and the pass report a clean sweep of nothing.
 */
export function clientPrefixOf(client: RedisClient): string {
  if (client instanceof Cluster) {
    return (client.options.redisOptions?.keyPrefix as string | undefined) ?? "";
  }
  return (client.options.keyPrefix as string | undefined) ?? "";
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
