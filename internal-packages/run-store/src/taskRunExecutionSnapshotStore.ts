// Decorates any RunStore so execution snapshots also land in Redis. It overrides only the methods
// that touch a snapshot and inherits the rest from the generated pass-through base.
//
// Write ORDER is the correctness property, and the two orders are deliberately different:
//
//   transition  Postgres first, Redis second. A crash in the gap leaves a run whose latest snapshot
//               is stale, which is exactly the state the heartbeat stall watchdog already heals.
//   birth       Redis first, Postgres second. A crash in the gap leaves an unreachable key for a run
//               that does not exist. Postgres-first would leave a run with no snapshot at all, and
//               getLatestExecutionSnapshot treats that as a hard error.
//
// Each order is chosen so the crash state is the harmless one. A lost cross-store write is never
// recovered by a transaction or an outbox: recovery is always the existing stall-and-repair job.
import { Logger } from "@trigger.dev/core/logger";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { DelegatingRunStore } from "./delegatingRunStore.js";
import type {
  CompletedWaitpointRef,
  RedisSnapshotStore,
  SnapshotEntryInput,
  SnapshotRead,
} from "./redisSnapshotStore.js";
import { deriveDistinctIds, deriveOrder } from "./redisSnapshotStore.js";
import {
  entryFromCompletion,
  entryFromCreateExecutionSnapshot,
  entryFromCreateRun,
  entryFromExpire,
  entryFromLock,
  entryFromReschedule,
  entryFromSnapshotRow,
  isTerminalEntry,
} from "./snapshotEntry.js";
import { isInjectedFault, type SnapshotFaultInjector } from "./snapshotFaultInjection.js";
import type {
  ReadClient,
  CompletionSnapshotInput,
  CreateCancelledRunInput,
  CreateExecutionSnapshotInput,
  CreateRunInput,
  ExpireSnapshotInput,
  LockRunData,
  RescheduleSnapshotInput,
  RunStore,
  TaskRunWithWaitpoint,
} from "./types.js";
import { matchSinceCursorLookup, matchSinceWindow } from "./snapshotReadShapes.js";
import { boundedIn } from "@trigger.dev/database";
import type { Prisma, PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";

/** One initial attempt plus three retries, per the write protocol. */
const APPEND_ATTEMPTS = 4;

// A `forked` or `skippedNoKeyspace` append did NOT persist the transition. Below redis-only that is
// survivable (Postgres holds the head: repair a fork, ignore a legitimate non-resident skip). At
// redis-only Postgres holds nothing, so #recordOutcome throws this instead, mirroring the thrown-error
// fatality the append loops already apply. The loops re-throw it at once rather than retrying, because
// a retry can neither create the keyspace nor unwind a fork.
class RedisOnlyAppendUnrecoverableError extends Error {
  constructor(outcome: string) {
    super(`snapshot store: append outcome "${outcome}" is unrecoverable at redis-only`);
    this.name = "RedisOnlyAppendUnrecoverableError";
  }
}

function isRedisOnlyAppendUnrecoverable(
  error: unknown
): error is RedisOnlyAppendUnrecoverableError {
  return error instanceof RedisOnlyAppendUnrecoverableError;
}

/**
 * Matches the engine's own chunked waitpoint fetch. A batch can complete a thousand waitpoints at
 * once, and an unbounded `in:` makes each distinct list length its own prepared statement.
 */
const WAITPOINT_CHUNK_SIZE = 100;

/**
 * The rollout dial. Postgres stays fully written and authoritative in every position before
 * `redis-only`, so every earlier position rolls back losslessly by turning the dial down.
 *
 * A `compare` position was named here before its behaviour existed, and it read from this type as a
 * real dial position while behaving in every respect exactly like `dual-write`. A dial value that
 * silently does something other than its name is worse than a missing one: turning it on would have
 * looked like enabling divergence reporting and delivered plain dual-write. It is added back by the
 * ticket that implements the sampled dual-read and diff, at which point the name will be true.
 */
export type SnapshotStoreMode = "off" | "dual-write" | "redis-read" | "redis-only";

/**
 * Resolves the dial for one write. `resolve` MUST be synchronous and MUST NOT query: seven methods
 * here take a caller-supplied `tx`, so this class cannot see a caller's transaction boundary, and a
 * read issued there could land inside someone else's open interactive transaction.
 */
export type SnapshotStoreModeResolver = {
  resolve(organizationId?: string): SnapshotStoreMode;
  /**
   * Optional, and awaited at BIRTH sites only. Resolves once the organisation's own dial value is
   * known to `resolve`, or once the attempt has given up.
   *
   * Why a birth is different from every other call. The per-organisation dial is served from a
   * short-lived cache, and on a miss the resolver answers with the deployment-wide position. For a
   * read or a transition that is the right trade. For a birth it is not: residency is decided at
   * birth and is permanent, so a run born during a cache miss is excluded from the mirror for its
   * entire life and no later pass can adopt it.
   *
   * That was not theoretical. Three runs born back to back were all resident; after a 14 minute idle
   * gap the next one was not, because the cache entry had expired. A miss is any gap longer than the
   * cache lifetime, so on bursty traffic the first run of every burst was silently excluded, and a
   * low-traffic canary organisation would have lost most of its runs.
   *
   * Implementations MUST bound this. A birth is on the trigger path and a caller may already hold an
   * open transaction, so a slow flag read must give up and leave `resolve` answering as before
   * rather than hold that transaction open. Failing is always allowed: the fallback is the previous
   * behaviour, never an error.
   */
  warm?(organizationId: string): Promise<void>;
  /**
   * Optional one-way global latch: has the deployment-wide dial EVER been non-off. False means the
   * global dial has never moved, so nothing was born resident by the global position; combined with a
   * definite per-org negative it is what lets a transition skip the keyspace probe. It is what makes
   * `off` genuinely inert rather than merely quiet: measured at 2 per cent with a healthy endpoint
   * and four times the run duration with a slow one, for every run, with no decay.
   *
   * MUST be synchronous and MUST NOT query. Conservative when cold: absent or true means "do not
   * skip", so any uncertainty keeps probing.
   */
  globalModeEverEnabled?(): boolean;
  /**
   * Optional per-organisation definite negative: is this organisation DEFINITELY never-enabled, i.e.
   * a source that is loaded AND has never seen this org enabled. True is the other half of the sound
   * skip: with the global dial unmoved and this org definitely never-enabled, no birth of its runs
   * ever mirrored, so no keyspace exists and a transition would be refused anyway.
   *
   * MUST be synchronous and MUST NOT query. Absent, false, or unknown (cold source) all mean "do not
   * skip", so any uncertainty keeps probing.
   */
  orgDefinitelyNeverEnabled?(organizationId: string): boolean;
  /**
   * Optional. The effective READ position for one run, org-scoped so a single org can be soaked at
   * `redis-read` while everyone else stays on Postgres. Same contract as `resolve`: synchronous, MUST
   * NOT query. Absent, or unresolved, falls back to the global mode, which is safe during soak.
   */
  readModeFor?(runId: string, environmentId?: string): SnapshotStoreMode | undefined;
  /**
   * Optional, ASYNC authoritative counterpart to `readModeFor`. Called only when `readModeFor` is
   * unresolved AND some org is `redis-only`, to decide whether a Postgres fallback would strand the
   * run. Bounded and MAY throw; the caller fails closed (no fallback) on a throw or when absent.
   */
  readModeForAuthoritative?(
    runId: string,
    environmentId?: string
  ): Promise<SnapshotStoreMode | undefined>;
  /**
   * Optional, cheap. Is ANY organisation currently at `redis-read` or `redis-only`. When false and
   * the global dial is not itself at a read position, a read short-circuits to Postgres without
   * resolving the run's org, keeping the dual-write soak phase at zero new read cost. Same contract:
   * synchronous, MUST NOT query.
   */
  anyOrgReadEnabled?(): boolean;
  /**
   * Optional, cheap. Is ANY organisation currently at `redis-only`. Governs the fallback gate when a
   * run's org cannot be resolved: with some org at `redis-only`, a Redis error on an unresolved run
   * must throw rather than serve an empty Postgres, because that org holds its snapshots nowhere
   * else. Same contract: synchronous, MUST NOT query.
   */
  anyOrgRedisOnly?(): boolean;
  /**
   * Optional. Records a run→org mapping the decorator learned for free — from a mirrored write or a
   * Redis read hit — so `readModeFor` later resolves the run's org from memory with no DB read. This
   * is what removes the run→org populate from the standing dual-write state: the mappings the read
   * path needs arrive as a side effect of the writes and read hits it was doing anyway. In-memory,
   * immutable, fire-and-forget, no TTL. MUST NOT throw and MUST NOT query.
   */
  prime?(runId: string, organizationId: string): void;
};

/**
 * Enqueues the existing `repairSnapshot` job for a run whose append was lost. The decorator lives in
 * run-store and cannot reach the engine's worker, so the binding is injected. That binding must
 * reuse the stall watchdog's job id for the run, or the watchdog and this path can start two
 * concurrent repairs on one run.
 */
export type SnapshotRepairEnqueuer = (args: {
  runId: string;
  snapshotId: string;
  executionStatus: string;
}) => Promise<void>;

/**
 * The hard stop, orthogonal to the dial because it answers a different question: the dial says how
 * far the rollout has got, this says whether to write at all right now. Re-read on every write so it
 * can be thrown without a deploy.
 *
 * Throwing it freezes every resident run's Redis head while Postgres advances, so it is a
 * resync-before-reads control, not a rollback. `off` is the lossless way down.
 */
export type SnapshotStoreHaltCheck = () => boolean;

/**
 * What one repair attempt did. Bounded so it can be a metric tag, and every value is an outcome the
 * caller only logs: no value here means the run needs anything further done to it.
 */
export type SnapshotRepairOutcome =
  | "halted"
  | "noSnapshot"
  | "notResident"
  | "alreadyCurrent"
  | "redisAhead"
  | "reappended"
  | "duplicate"
  | "forked";

/** The two seams the snapshot repair job needs, present only when the mirror is wired up. */
export type SnapshotMirrorRepair = {
  authoritativeStore(): RunStore;
  repairRedisHead(runId: string, snapshotId: string): Promise<SnapshotRepairOutcome>;
};

export function asSnapshotMirrorRepair(store: RunStore): SnapshotMirrorRepair | undefined {
  return store instanceof TaskRunExecutionSnapshotStore ? store : undefined;
}

export type DecoratorMetrics = {
  recordWrite(site: string, outcome: string): void;
  recordAppendFailed(site: string, organizationId?: string): void;
  recordRead(method: string, source: "redis" | "postgres"): void;
};

export type TaskRunExecutionSnapshotStoreOptions = {
  store: RedisSnapshotStore;
  /** Defaults to `off`, which is a pure pass-through that never touches Redis. */
  mode?: SnapshotStoreMode;
  /** Takes precedence over `mode`, and is re-read on every write so the dial can move at runtime. */
  modeResolver?: SnapshotStoreModeResolver;
  /** Defaults to never halted. */
  halted?: SnapshotStoreHaltCheck;
  onAppendFailure?: SnapshotRepairEnqueuer;
  faults?: SnapshotFaultInjector;
  metrics?: DecoratorMetrics;
  logger?: Logger;
  /**
   * Internal. Set only by the staging facade this class builds for `runInTransaction`. When present,
   * an intercepted write does its Postgres half and pushes its entry here instead of appending, and
   * the outer instance flushes the buffer after the transaction commits.
   */
  staging?: StagedAppend[];
};

/** One deferred append: the entry, plus the wait cycle it carries, if any. */
export type StagedAppend = {
  entry: SnapshotEntryInput;
  /**
   * The head this append expects, carried through staging so the compare-and-set survives the
   * deferral. Dropping it would silently disable the fork guard for every snapshot written inside a
   * transaction, and a stale append that should be rejected would instead become the head.
   */
  expectedCur?: string;
  completedWaitpoints?: CompletedWaitpointRef[];
};

export class TaskRunExecutionSnapshotStore extends DelegatingRunStore {
  readonly #staticMode: SnapshotStoreMode;
  protected readonly modeResolver?: SnapshotStoreModeResolver;
  protected readonly redis: RedisSnapshotStore;
  protected readonly haltCheck?: SnapshotStoreHaltCheck;
  protected readonly onAppendFailure?: SnapshotRepairEnqueuer;
  protected readonly faults?: SnapshotFaultInjector;
  protected readonly metrics?: DecoratorMetrics;
  protected readonly logger: Logger;
  protected readonly staging?: StagedAppend[];

  constructor(delegate: RunStore, options: TaskRunExecutionSnapshotStoreOptions) {
    super(delegate);
    this.redis = options.store;
    this.#staticMode = options.mode ?? "off";
    this.modeResolver = options.modeResolver;
    this.haltCheck = options.halted;
    this.onAppendFailure = options.onAppendFailure;
    this.faults = options.faults;
    this.metrics = options.metrics;
    this.logger = options.logger ?? new Logger("TaskRunExecutionSnapshotStore", "debug");
    this.staging = options.staging;
  }

  get mode(): SnapshotStoreMode {
    return this.modeResolver?.resolve() ?? this.#staticMode;
  }

  /** The resolved position for one organisation. Falls back to the global answer when unknown. */
  protected modeFor(organizationId?: string): SnapshotStoreMode {
    return this.modeResolver?.resolve(organizationId) ?? this.#staticMode;
  }

  /**
   * Feeds the run→org cache a mapping learned for free on a mirrored write or a Redis read hit, so a
   * later read resolves the run's org with no DB. Best-effort: a resolver that offers no hook, or a
   * write with no org, is a no-op, and a throw is swallowed so a cache write never fails a store op.
   */
  #prime(runId: string, organizationId?: string): void {
    if (!organizationId) return;
    try {
      this.modeResolver?.prime?.(runId, organizationId);
    } catch {
      // priming is fire-and-forget; a cache write must never fail the caller's read or write.
    }
  }

  /** Whether the hard stop is thrown. A halt beats every dial position, in both directions. */
  protected halted(): boolean {
    try {
      return this.haltCheck?.() === true;
    } catch {
      // An unreadable switch must not decide anything. Halting on an error would freeze every
      // resident run's head, which is the outcome this whole area exists to avoid.
      return false;
    }
  }

  /**
   * Whether a BIRTH mirrors to Redis. This is the only decision the per-organisation override gets
   * to make, and it fixes the run's store for the rest of its life.
   */
  /**
   * Waits for the organisation's real dial value before a birth decides residency. Never throws:
   * a flag read that fails or times out leaves `resolve` answering exactly as it did before, which
   * is the behaviour this replaces.
   */
  async #warmOrgMode(organizationId?: string): Promise<void> {
    if (!organizationId || !this.modeResolver?.warm) {
      return;
    }
    try {
      await this.modeResolver.warm(organizationId);
    } catch (error) {
      this.logger.warn("snapshot store could not warm the organisation dial before a birth", {
        organizationId,
        error,
      });
    }
  }

  protected writesRedisForBirth(organizationId?: string): boolean {
    if (this.halted()) return false;

    return this.modeFor(organizationId) !== "off";
  }

  /**
   * Whether a TRANSITION mirrors to Redis. A transition never re-decides residency by the org's
   * CURRENT dial — that would let a run change stores half way through its life, the one thing the
   * design forbids. A transition belongs to a run that is already resident or already absent, and
   * the append script refuses a transition into a keyspace that does not exist, so the keyspace IS
   * the per-run residency record and the default is to attempt the append and let Redis answer.
   *
   * The one exception is the sound skip below: when NOTHING of this org's could ever have been born
   * resident, the append would be refused anyway, so it is skipped without a probe. That test is by
   * absence and by the global one-way latch, not by the org's live dial, so it cannot freeze a
   * resident run. Everything else probes.
   *
   * `off` is deliberately NOT a reason to skip a resident run's transition. An operator turning the
   * dial down to `off` mid-incident must not freeze every resident run's head while Postgres advances,
   * which would make the remedy indistinguishable from the fault. `off` stops new residency only:
   * births stop, resident runs keep mirroring, and the mirror drains as they finish. Stopping
   * outright is the halt switch, and it is a resync control rather than a rollback.
   */
  protected writesRedisForTransition(organizationId?: string): boolean {
    if (this.halted()) {
      return false;
    }

    // The ONLY case where a transition may be skipped without a keyspace check. Soundness invariant:
    // a run is resident only if modeFor(org) != off at its birth, i.e. the org had an override OR the
    // global dial was non-off. So skipping is safe only when the global dial was NEVER non-off
    // (globalModeEverEnabled() === false) AND this org is DEFINITELY never-enabled
    // (orgDefinitelyNeverEnabled(org) === true). With both true, no birth of this org's runs ever
    // mirrored, so no keyspace exists and the append script would refuse every one of these anyway.
    // Any uncertainty (cold registry or census, absent signal, undefined org) leaves a guard
    // unsatisfied and the transition probes: fail-safe toward asking.
    //
    // Accepted transient at the enabling edge, not made airtight: the census is eventually
    // consistent, so a just-enabled org may briefly still read as definitely-never-enabled and a
    // transition could skip. It is recoverable (the census reloads within its interval and later
    // transitions mirror again) and harmless at dual-write (Postgres is authoritative; an org reaches
    // a read position only after soak far longer than census convergence). The enabling save refreshes
    // the census in its own process to shrink the window; other pods lag at most the reload interval.
    if (
      organizationId !== undefined &&
      this.modeResolver?.globalModeEverEnabled?.() === false &&
      this.modeResolver?.orgDefinitelyNeverEnabled?.(organizationId) === true
    ) {
      return false;
    }

    return true;
  }

  /** Test seams for the two predicates. Not for production callers. */
  writesRedisForBirthTest(organizationId?: string): boolean {
    return this.writesRedisForBirth(organizationId);
  }

  writesRedisForTransitionTest(organizationId?: string): boolean {
    return this.writesRedisForTransition(organizationId);
  }

  haltedTest(): boolean {
    return this.halted();
  }

  /** Test seam for the resolved position. Not for production callers. */
  modeForTest(organizationId?: string): SnapshotStoreMode {
    return this.modeFor(organizationId);
  }

  /**
   * The staging facade. Two writes share one Postgres transaction here, and the Redis half of each
   * cannot run until that transaction commits: a rollback would otherwise leave Redis holding a
   * transition that never happened.
   *
   * The callback gets a second decorator over the transaction-bound store, carrying a staging
   * buffer. An intercepted write does its Postgres half through that store and pushes its entry
   * onto the buffer. After the transaction resolves, this instance flushes the buffer in order
   * through the same retry-and-repair path a lone transition uses. If the callback throws, the
   * delegate rejects, the flush never runs, and the buffer goes away with the stack — so the
   * Postgres rollback and the Redis silence agree.
   */
  override async runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    // Always stage. This method holds only a runId, so it cannot know whether the writes inside
    // belong to a resident run. A birth inside the callback still resolves its own organisation's
    // dial as it is staged; a transition stages unconditionally, as it does outside a transaction.
    const staged: StagedAppend[] = [];

    const result = await this.delegate.runInTransaction(runId, (store, tx) =>
      fn(this.#wrap(store, staged), tx)
    );

    // The transaction committed. Only now can a snapshot claim its partner is durable.
    for (const item of staged) {
      await this.#appendTransition(
        "runInTransaction",
        item.entry,
        item.expectedCur,
        item.completedWaitpoints
      );
    }

    return result;
  }

  /**
   * `forWaitpointCompletion` hands the caller a store to apply a completion on. No snapshot write
   * goes through that handle today, so wrapping it changes nothing now; leaving it unwrapped is the
   * one hole that would let a future snapshot write bypass the decorator with no signal at all.
   */
  override async forWaitpointCompletion(
    waitpointId: string,
    context: Parameters<RunStore["forWaitpointCompletion"]>[1]
  ): Promise<RunStore> {
    const store = await this.delegate.forWaitpointCompletion(waitpointId, context);

    // Carry the staging buffer through. Without it, a handle taken inside a transaction appends
    // immediately, which is the exact ordering the facade exists to prevent.
    return this.#wrap(store, this.staging);
  }

  /**
   * A second decorator over another store, sharing this one's options. One class in both roles keeps
   * the write-ordering logic in exactly one place. Passing no buffer gives a plain decorator that
   * appends immediately; passing one makes it stage instead.
   */
  #wrap(store: RunStore, staging?: StagedAppend[]): TaskRunExecutionSnapshotStore {
    return new TaskRunExecutionSnapshotStore(store, {
      store: this.redis,
      mode: this.#staticMode,
      ...(this.haltCheck && { halted: this.haltCheck }),
      ...(this.modeResolver && { modeResolver: this.modeResolver }),
      logger: this.logger,
      ...(this.onAppendFailure && { onAppendFailure: this.onAppendFailure }),
      ...(this.faults && { faults: this.faults }),
      ...(this.metrics && { metrics: this.metrics }),
      ...(staging && { staging }),
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Births: Redis first, Postgres second.
  // ---------------------------------------------------------------------------------------------

  override async createRun(
    params: CreateRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    // Before the decision, not after: residency is permanent, so this is the one call where the
    // organisation's real value is worth waiting for.
    await this.#warmOrgMode(params.snapshot?.organizationId);

    if (!this.writesRedisForBirth(params.snapshot?.organizationId)) {
      // Deliberately records NOTHING about residency here, though it is tempting: this run is
      // almost certainly non-resident, and seeding that would save its first transition a probe.
      //
      // It is not safe. A birth path can be re-entered (createCancelledRun has an explicit
      // "row already exists" path), so a birth that DID mirror on its first attempt can reach here
      // on a retry once the short-lived override cache has moved to off. Seeding a negative from a
      // local decision would then suppress every later transition of a run that is resident,
      // freezing its head while Postgres moved on: the exact failure the residency model exists to
      // prevent. Only the append script's own reply is authoritative about a keyspace, so only that
      // reply may create a negative.
      return this.delegate.createRun(params, tx);
    }

    const ctx = this.#context(params.data.id, params.snapshot.id);
    const snapshot = { ...params.snapshot, id: ctx.id, createdAt: ctx.createdAt };

    await this.#appendBirth("createRun", entryFromCreateRun(ctx, snapshot));

    return this.delegate.createRun({ ...params, snapshot }, tx);
  }

  override async createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    await this.#warmOrgMode(params.snapshot?.organizationId);

    if (!this.writesRedisForBirth(params.snapshot?.organizationId)) {
      return this.delegate.createCancelledRun(params, tx);
    }

    const ctx = this.#context(params.data.id, params.snapshot.id);
    const snapshot = { ...params.snapshot, id: ctx.id, createdAt: ctx.createdAt };

    await this.#appendBirth("createCancelledRun", entryFromCreateRun(ctx, snapshot));

    return this.delegate.createCancelledRun({ ...params, snapshot }, tx);
  }

  // ---------------------------------------------------------------------------------------------
  // Transitions: Postgres first, Redis second.
  // ---------------------------------------------------------------------------------------------

  override async completeAttemptSuccess<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      completedAt: Date;
      output?: string;
      outputType: string;
      usageDurationMs: number;
      costInCents: number;
      snapshot: CompletionSnapshotInput;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    if (!this.writesRedisForTransition(data.snapshot?.organizationId)) {
      return this.delegate.completeAttemptSuccess(runId, data, args, tx);
    }

    const ctx = this.#context(runId, data.snapshot.id);
    const withId = {
      ...data,
      snapshot: { ...data.snapshot, id: ctx.id, createdAt: ctx.createdAt },
    };

    const result = await this.delegate.completeAttemptSuccess(runId, withId, args, tx);

    await this.#appendTransition(
      "completeAttemptSuccess",
      entryFromCompletion(ctx, withId.snapshot)
    );
    return result;
  }

  override async expireRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { error: unknown; completedAt: Date; expiredAt: Date; snapshot: ExpireSnapshotInput },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    if (!this.writesRedisForTransition(data.snapshot?.organizationId)) {
      return this.delegate.expireRun(runId, data as never, args, tx);
    }

    const ctx = this.#context(runId, data.snapshot.id);
    const withId = {
      ...data,
      snapshot: { ...data.snapshot, id: ctx.id, createdAt: ctx.createdAt },
    };

    const result = await this.delegate.expireRun(runId, withId as never, args, tx);

    await this.#appendTransition("expireRun", entryFromExpire(ctx, withId.snapshot));
    return result;
  }

  override async expireParkedRun(
    runId: string,
    data: {
      error: unknown;
      completedAt: Date;
      expiredAt: Date;
      statusReason: string;
      snapshot: ExpireSnapshotInput;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    if (!this.writesRedisForTransition(data.snapshot?.organizationId)) {
      return this.delegate.expireParkedRun(runId, data as never, tx);
    }

    const ctx = this.#context(runId, data.snapshot.id);
    const withId = {
      ...data,
      snapshot: { ...data.snapshot, id: ctx.id, createdAt: ctx.createdAt },
    };

    const result = await this.delegate.expireParkedRun(runId, withId as never, tx);

    // The delegate writes nothing when the run is no longer PENDING_VERSION, so neither does Redis.
    if (result.count > 0) {
      await this.#appendTransition("expireParkedRun", entryFromExpire(ctx, withId.snapshot));
    }
    return result;
  }

  override async rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    // The delegate writes a snapshot only when one is supplied, so an absent snapshot is a plain run
    // update with nothing for Redis to mirror.
    if (!data.snapshot || !this.writesRedisForTransition(data.snapshot?.organizationId)) {
      return this.delegate.rescheduleRun(runId, data, tx);
    }

    const ctx = this.#context(runId, data.snapshot.id);
    const withId = {
      ...data,
      snapshot: { ...data.snapshot, id: ctx.id, createdAt: ctx.createdAt },
    };

    const result = await this.delegate.rescheduleRun(runId, withId, tx);

    await this.#appendTransition("rescheduleRun", entryFromReschedule(ctx, withId.snapshot));
    return result;
  }

  override async lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<Record<string, never>>> {
    if (!this.writesRedisForTransition(data.snapshot?.organizationId)) {
      return this.delegate.lockRunToWorker(runId, data, tx);
    }

    // This is the one transition whose input already carries both an id and the previous snapshot
    // id, so it is also the one that can append under a compare-and-set on the current head.
    const ctx = { id: data.snapshot.id, runId, createdAt: new Date() };
    const withStamp = { ...data, snapshot: { ...data.snapshot, createdAt: ctx.createdAt } };

    const result = await this.delegate.lockRunToWorker(runId, withStamp, tx);

    await this.#appendTransition(
      "lockRunToWorker",
      entryFromLock(ctx, withStamp.snapshot),
      withStamp.snapshot.previousSnapshotId,
      // Built from the COMPLETE id set, which is what the delegate connects in Postgres, with the
      // index taken from the ordered list where the id appears in it. Building from the ordered list
      // instead would drop every id with no batch index, exactly the ids Postgres still records.
      lockCycleRefs(
        withStamp.snapshot.completedWaitpointIds,
        withStamp.snapshot.completedWaitpointOrder
      )
    );
    return result;
  }

  override async createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    if (!this.writesRedisForTransition(input.organizationId)) {
      return this.delegate.createExecutionSnapshot(input, tx);
    }

    const ctx = this.#context(input.run.id, input.id);
    const created = await this.delegate.createExecutionSnapshot(
      { ...input, id: ctx.id, createdAt: ctx.createdAt },
      tx
    );

    // The standalone path is the only one whose delegate returns the row, so its entry can take the
    // exact createdAt Postgres recorded rather than the decorator's own clock.
    await this.#appendTransition(
      "createExecutionSnapshot",
      entryFromCreateExecutionSnapshot(ctx, input),
      input.previousSnapshotId,
      input.completedWaitpoints
    );
    return created;
  }

  // ---------------------------------------------------------------------------------------------
  // The append protocol.
  // ---------------------------------------------------------------------------------------------

  /** Mints the id when the caller did not, and stamps one clock for both stores. */
  #context(runId: string, suppliedId?: string) {
    return { id: suppliedId ?? generateInternalId(), runId, createdAt: new Date() };
  }

  /**
   * Births invert the order. Postgres-first would leave a run with no snapshot at all, and
   * `getLatestExecutionSnapshot` treats that as a hard error, so the run would be stuck. Redis-first
   * leaves an orphaned keyspace for a run that does not exist, which nothing can reach and the
   * sweep's second rule reaps.
   *
   * Being first is also what lets this path refuse. Before `redis-only` a failed birth append is
   * survivable, because Postgres is authoritative and holds the snapshot; at `redis-only` Postgres
   * writes no snapshot, so a run created without its Redis birth would have no snapshot anywhere.
   * Throwing here happens before the run row exists, so the caller retries a clean creation.
   */
  async #appendBirth(site: string, entry: SnapshotEntryInput): Promise<void> {
    // A birth reaches here only when it mirrors, so its run is resident: learn the run→org mapping
    // now, off the write it was doing anyway, so the read path never has to query for it.
    this.#prime(entry.runId, entry.organizationId);

    if (this.staging) {
      // A birth inside a transaction cannot be staged: staging flushes after the commit, which is
      // the opposite of what a birth needs. No caller does this today, so say so and append now.
      this.logger.error("a run birth inside a transaction cannot be staged", {
        runId: entry.runId,
        site,
      });
    }

    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
      try {
        const result = await this.redis.append({
          entry,
          kind: "birth",
          isTerminal: isTerminalEntry(entry),
        });
        await this.#recordOutcome(site, entry, result);

        // Modelled AFTER the successful append: the crash this boundary represents is a process that
        // died between the two stores, not an append that failed.
        this.faults?.("afterRedisBirthBeforePg", { runId: entry.runId, snapshotId: entry.id });
        return;
      } catch (error) {
        // A non-persisting outcome at redis-only is fatal; never retry it (a retry cannot create the
        // keyspace), so run creation fails loudly rather than being born unrecorded.
        if (isRedisOnlyAppendUnrecoverable(error)) {
          throw error;
        }
        if (isInjectedFault(error)) {
          throw error;
        }

        if (attempt === APPEND_ATTEMPTS - 1) {
          this.metrics?.recordAppendFailed(site, entry.organizationId);
          this.logger.error("snapshot birth append failed after retries", {
            runId: entry.runId,
            snapshotId: entry.id,
            site,
            mode: this.mode,
            error,
          });

          // The same organisation dial that decided to append decides whether a lost birth is
          // fatal. Using the global position here would fail run creation for an organisation whose
          // own position still has Postgres authoritative.
          if (this.modeFor(entry.organizationId) === "redis-only") {
            throw error;
          }
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  }

  /**
   * Postgres has already committed by the time this runs. A throw here would turn a gap the stall
   * watchdog heals into a caller-visible failure, so it never rethrows: it retries, then hands the
   * run to the repair job and returns.
   */
  async #appendTransition(
    site: string,
    entry: SnapshotEntryInput,
    expectedCur?: string,
    completedWaitpoints?: CompletedWaitpointRef[]
  ): Promise<void> {
    // A transition mirrors only for a resident run, so learn its run→org mapping here too, whether it
    // is staged now or appended immediately.
    this.#prime(entry.runId, entry.organizationId);

    if (this.staging) {
      // Inside a transaction the append cannot run until the Postgres side commits, or a rollback
      // leaves Redis holding a transition that never happened.
      this.staging.push({
        entry,
        ...(expectedCur !== undefined && { expectedCur }),
        ...(completedWaitpoints && { completedWaitpoints }),
      });
      return;
    }

    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
      try {
        this.faults?.(attempt === 0 ? "afterPgBeforeRedis" : "midFlushRetry", {
          runId: entry.runId,
          snapshotId: entry.id,
        });

        const cycle = await this.#resolveCycle(entry.runId, completedWaitpoints);

        const result = await this.redis.append({
          entry,
          kind: "transition",
          isTerminal: isTerminalEntry(entry),
          ...(expectedCur !== undefined && { expectedCur }),
          ...(cycle && { cycle }),
        });

        await this.#recordOutcome(site, entry, result);
        return;
      } catch (error) {
        // A non-persisting outcome at redis-only is fatal: never retry it (the keyspace cannot appear
        // and a fork cannot unwind), surface it at once.
        if (isRedisOnlyAppendUnrecoverable(error)) {
          throw error;
        }
        // An injected fault models a dead process, not a retryable append failure.
        if (isInjectedFault(error)) {
          this.metrics?.recordAppendFailed(site, entry.organizationId);
          // At redis-only Postgres holds nothing, so a lost transition is unrecoverable and the
          // repair cannot help: surface it instead, as the birth path does.
          if (this.modeFor(entry.organizationId) === "redis-only") {
            throw error;
          }
          await this.#enqueueRepair(entry);
          return;
        }

        if (attempt === APPEND_ATTEMPTS - 1) {
          this.metrics?.recordAppendFailed(site, entry.organizationId);
          this.logger.error("snapshot append failed after retries", {
            runId: entry.runId,
            snapshotId: entry.id,
            site,
            error,
          });
          if (this.modeFor(entry.organizationId) === "redis-only") {
            throw error;
          }
          await this.#enqueueRepair(entry);
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
    }
  }

  /**
   * The undecorated store. A repair MUST read through this and not through `this`: once reads are
   * served from Redis, reading through the decorator hands the repair the very stale head it exists
   * to replace, so it sees the id it was asked about missing and concludes there is nothing to do.
   */
  authoritativeStore(): RunStore {
    return this.delegate;
  }

  /**
   * Re-appends the Postgres head of a run whose mirror append was lost.
   *
   * Additive only, and neither of the append script's guards is reimplemented here: an entry that
   * already landed comes back `duplicate`, and a run with no keyspace comes back
   * `skippedNoKeyspace`, which is how a run that was never resident stays non-resident.
   *
   * No compare-and-set: asserting cur would refuse exactly when the mirror is furthest behind and a
   * stale head is doing the most damage. The one ordering rule kept is that the repair will not
   * append behind a mirror head already newer than Postgres.
   */
  async repairRedisHead(runId: string, snapshotId: string): Promise<SnapshotRepairOutcome> {
    if (!this.writesRedisForTransition()) {
      // The hard stop, not the dial: the dial governs births and never refuses a repair.
      return "halted";
    }

    const row = await this.delegate.findLatestExecutionSnapshot(runId);

    if (!row) {
      return "noSnapshot";
    }

    // The target is the head Postgres holds NOW, not the snapshot the job names. The repair is
    // delayed, so the run has usually moved on by the time it runs, and the entry that was lost is
    // unreachable by then; the mirror head is still wrong, and a wrong head is what a Redis-served
    // read returns.
    if (row.id !== snapshotId) {
      this.logger.log("snapshot repair target advanced", {
        runId,
        enqueuedFor: snapshotId,
        head: row.id,
      });
    }

    const head = await this.redis.getLatest(runId);

    if (head?.id === row.id) {
      // The head converged on its own, but a repair only runs because an append was LOST, so the
      // entries behind that head can still be missing. This is the case observed live: four entries
      // in Redis against eight in Postgres, with a matching head. Returning here without marking is
      // what let a short window be served as though it were whole.
      await this.redis.markGapsIfResident(runId);
      return "alreadyCurrent";
    }

    if (head && headIsNewerThan(head, row.createdAt)) {
      // Redis ahead of the Postgres head is divergence too, whichever way round it is.
      await this.redis.markGapsIfResident(runId);
      return "redisAhead";
    }

    const entry = entryFromSnapshotRow(row);
    const refs = lockCycleRefs(
      row.completedWaitpoints.map((waitpoint) => waitpoint.id),
      row.completedWaitpointOrder
    );
    const cycle = await this.#resolveCycle(runId, refs);

    const result = await this.redis.append({
      entry,
      kind: "transition",
      isTerminal: isTerminalEntry(entry),
      // A repair runs BECAUSE an append was lost. Whatever it manages to put back, the entries in
      // between are gone for good, and a window read cannot detect a hole. So the keyspace is marked
      // and its windows fall back to Postgres, which still holds the whole log. Backfilling the lost
      // entries instead would be worse: a late append takes a fresh seq, and the window scripts walk
      // the index in seq order as though it were time order, so an old entry with a high seq
      // truncates the window harder than the hole does.
      markGaps: true,
      ...(cycle && { cycle }),
    });

    this.metrics?.recordWrite("repairRedisHead", result.outcome);

    switch (result.outcome) {
      case "written":
        return "reappended";
      case "duplicate":
        return "duplicate";
      case "skippedNoKeyspace":
        return "notResident";
      case "forked":
        return "forked";
    }
  }

  /**
   * Decides whether this append mints a new wait cycle or points at the one already there.
   *
   * A resume append carries a newly-differing id set, so it mints a cycle and the record set is
   * written once. Every copy-forward append that follows re-passes the SAME list, and re-minting on
   * each would rewrite the record set once per entry in the resume chain — the write amplification
   * the pointer model exists to remove. So an unchanged id set carries the previous cycleSeq
   * forward and writes no key.
   *
   * The extra read only happens for an append that actually carries waitpoints, which is the resume
   * path rather than the hot path.
   *
   * `records` is deliberately left unset. The record envelope belongs to the waitpoint lane and
   * ships empty in this build, so dual-write never re-versions the entry when it arrives.
   */
  async #resolveCycle(
    runId: string,
    completedWaitpoints?: CompletedWaitpointRef[]
  ): Promise<
    | { kind: "new"; completedWaitpoints: CompletedWaitpointRef[] }
    | { kind: "carryForward"; cycleSeq: number; completedWaitpoints: CompletedWaitpointRef[] }
    | undefined
  > {
    if (!completedWaitpoints || completedWaitpoints.length === 0) {
      return undefined;
    }

    const order = deriveOrder(completedWaitpoints);
    const distinct = deriveDistinctIds(completedWaitpoints);

    try {
      const head = await this.redis.getLatest(runId);
      const previousIds = head?.completedWaitpointIds;

      // Both halves must match. Comparing the order alone is not enough: it holds only indexed ids,
      // so two DIFFERENT single waits both present an empty order and would compare equal, and the
      // second would inherit the first's waitpoint set instead of minting its own.
      if (
        head?.cycle &&
        previousIds &&
        sameOrder(previousIds.order, order) &&
        sameSet(previousIds.distinctIds, distinct)
      ) {
        return {
          kind: "carryForward",
          cycleSeq: head.cycle.cycleSeq,
          completedWaitpoints,
        };
      }
    } catch (error) {
      // A failed probe must not lose the waitpoints. Minting a fresh cycle is the safe direction:
      // it costs one duplicated record set, where a wrong carryForward would point at another
      // cycle's ids.
      this.logger.warn("snapshot cycle probe failed, minting a new cycle", { runId, error });
    }

    return { kind: "new", completedWaitpoints };
  }

  /**
   * No append outcome is a thrown failure. Exactly one of them enqueues a repair.
   *
   * `skippedNoKeyspace` is a run that is not resident: every pre-cutover run's transitions, and
   * every run whose organisation was at `off` when it was born. `duplicate` is a retry that already
   * landed. `cycleMismatch` means the store refused an untrustworthy waitpoint pointer on purpose.
   * None of those three is a fault, and none enqueues anything.
   *
   * `forked` is none of those. It was read as expected contention, from a model where any writer
   * could append to any run. With a run's store fixed at birth the writer set per run is stable, so
   * a fork is either a lost append or a genuinely concurrent writer, and by the time it is seen the
   * head already disagrees with Postgres.
   *
   * A fork therefore enqueues a repair as well as paging. It did not, once, and that was a defect:
   * the two compare-and-set sites assert the head, so a head left wrong makes every later append
   * from those sites fork too, and the mirror stays frozen for the rest of the run's life. Nothing
   * else clears it. The sweep will not: it skips live runs by design.
   *
   * Two earlier attempts at Postgres-driven head repair in this area were withdrawn as unsafe, and
   * this is not a third. Both asserted `cur` while re-appending, so they could fork on the very
   * condition they were sent to fix. This repair asserts nothing: it re-derives the head from
   * Postgres, refuses when the mirror head is already current or demonstrably newer, and marks the
   * keyspace so window reads fall back rather than serve the entries the fork lost. See the
   * SnapshotStoreAppendForked rule, which now reads as "divergence happened" rather than "divergence
   * persists".
   */
  async #recordOutcome(
    site: string,
    entry: SnapshotEntryInput,
    result: Awaited<ReturnType<RedisSnapshotStore["append"]>>
  ): Promise<void> {
    this.metrics?.recordWrite(site, result.outcome);

    // At redis-only Postgres holds no snapshot for this run, so an outcome that did not persist the
    // transition is unrecoverable: a fork cannot be repaired from an empty Postgres, and a
    // skippedNoKeyspace has nowhere else to land. Surface a retryable failure rather than enqueue a
    // doomed repair or silently drop it, matching the thrown-error fatality in the append loops.
    if (
      (result.outcome === "forked" || result.outcome === "skippedNoKeyspace") &&
      this.modeFor(entry.organizationId) === "redis-only"
    ) {
      this.logger.error("snapshot append did not persist at redis-only", {
        runId: entry.runId,
        snapshotId: entry.id,
        site,
        outcome: result.outcome,
      });
      throw new RedisOnlyAppendUnrecoverableError(result.outcome);
    }

    if (result.outcome === "forked") {
      this.logger.error("snapshot append forked", {
        runId: entry.runId,
        snapshotId: entry.id,
        site,
        actualCur: result.actualCur,
      });

      // A fork is not a race to shrug at: the two compare-and-set sites assert the head, so once it
      // is wrong every later append from them forks too and the mirror is frozen for the rest of the
      // run. The repair re-derives the head from Postgres without asserting `cur`, which is the one
      // operation that clears this, so ask for it rather than only reporting.
      await this.#enqueueRepair(entry);
    }
  }

  /** Test seam for the outcome handler. Not for production callers. */
  async recordOutcomeForTest(
    site: string,
    entry: SnapshotEntryInput,
    result: Awaited<ReturnType<RedisSnapshotStore["append"]>>
  ): Promise<void> {
    await this.#recordOutcome(site, entry, result);
  }

  // ---------------------------------------------------------------------------------------------
  // Reads.
  //
  // Only three production call sites exist, all in the engine's executionSnapshotSystem, all with
  // fixed argument shapes. The two generic Prisma-args methods therefore recognise exactly the
  // shapes the engine sends and delegate everything else: an unrecognised shape must go to Postgres,
  // never get an approximate answer from Redis.
  // ---------------------------------------------------------------------------------------------

  /**
   * Whether this run's reads come from Redis. Hashed on the run id so a run does not change store
   * between two reads of the same poll, which would let a caller see the log go backwards.
   */
  /**
   * Whether a failed Redis read may be answered from Postgres.
   *
   * The read paths fell back on a MISS and on a dangling cycle, but not on an ERROR, so a brownout
   * at `redis-read` turned an engine read into a throw once the command timed out. Postgres still
   * holds every row below `redis-only`, so falling back is strictly better than failing.
   *
   * At `redis-only` it is not an option: nothing else holds the rows, so the error is the answer and
   * hiding it would serve an empty history as though it were real. Org-scoped, so a single org soaked
   * at `redis-only` throws while everyone else still falls back.
   */
  async #fallbackAllowed(runId?: string, environmentId?: string): Promise<boolean> {
    // A RESOLVED per-run answer is authoritative and wins over the global dial. Postgres suppression
    // is org-scoped, so an org resolved BELOW redis-only has its whole log in Postgres even when the
    // GLOBAL dial has advanced to redis-only; refusing the fallback there would strand a run whose
    // rows are sitting readable in Postgres. A run resolved TO redis-only still refuses (even when
    // anyOrgRedisOnly has not caught the enable); a concrete non-`redis-only` mode falls back, even
    // when a DIFFERENT org is `redis-only`. So this check precedes the global short-circuit below.
    if (runId !== undefined) {
      const resolved = this.modeResolver?.readModeFor?.(runId, environmentId);
      if (resolved === "redis-only") return false;
      if (resolved !== undefined) return true;
    }

    // Org unresolved (cold run→org cache, or no runId). At a global redis-only we cannot prove
    // Postgres holds this run, so refuse rather than serve an empty history as though it were real.
    if (this.mode === "redis-only") return false;

    // If no org is `redis-only`, this run cannot be either, so Postgres is a valid answer.
    if (this.modeResolver?.anyOrgRedisOnly?.() !== true) return true;

    // Some org IS redis-only and the sync cache cannot tell if it is this one. Resolve the run's org
    // authoritatively rather than strand a redis-only run or over-throw a pre-cutover one. An absent
    // hook, an undefined answer, or a bounded read that fails all fail closed: a retryable throw beats
    // serving an empty Postgres when some org genuinely has nowhere else.
    //
    // A missing runId cannot be attributed to a redis-only org, and every engine read of a resident
    // run threads one; global redis-only is already handled above. So fall back rather than over-throw
    // the run-id-less fan-out that only exists below redis-only.
    if (runId === undefined) return true;
    try {
      const authoritative = await this.modeResolver?.readModeForAuthoritative?.(
        runId,
        environmentId
      );
      if (authoritative === undefined) return false;
      return authoritative !== "redis-only";
    } catch {
      return false;
    }
  }

  // Thrown when a redis-only run cannot fall back to Postgres (a miss, a dangling cycle, or a routed
  // read Redis cannot serve). Retryable by design: the head may still be catching up, and serving an
  // empty Postgres would strand the run.
  #redisOnlyMissError(): Error {
    return new Error("snapshot store: run is redis-only, so Postgres cannot serve this read");
  }

  #reportReadUnavailable(method: string, runId: string, error: unknown): void {
    this.logger.warn("snapshot read fell back to Postgres after a store error", {
      method,
      runId,
      error,
    });
    this.metrics?.recordRead(method, "postgres");
  }

  protected readsFromRedis(runId: string, environmentId?: string): boolean {
    // Short-circuit before any org resolution: while no org is read-enabled and the global dial is
    // not itself at a read position, nothing reads from Redis, so skip resolving the run's org
    // entirely. This is what keeps the dual-write soak phase at zero new read cost.
    if (
      this.modeResolver?.anyOrgReadEnabled?.() !== true &&
      this.mode !== "redis-read" &&
      this.mode !== "redis-only"
    ) {
      return false;
    }

    // The org-scoped read position, falling back to the global answer when unresolved.
    const effective = this.modeResolver?.readModeFor?.(runId, environmentId) ?? this.mode;

    if (effective !== "redis-read" && effective !== "redis-only") return false;

    // At `redis-only` Postgres holds no snapshot rows, so a run routed away from Redis reads nothing
    // at all. Always reading from Redis here makes that misconfiguration unreachable.
    if (effective === "redis-only") return true;

    // Halted heads are frozen, and below `redis-only` Postgres still holds the whole log, so serving
    // reads from it is strictly better than serving a head that stopped moving.
    if (this.halted()) return false;

    // `redis-read` is org-gated: an org at this position reads every one of its runs from Redis, with
    // Postgres as the fallback on a miss or error.
    return true;
  }

  override async findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient,
    environmentId?: string
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{
    include: { completedWaitpoints: true; checkpoint: true };
  }> | null> {
    if (!this.readsFromRedis(runId, environmentId)) {
      if (!(await this.#fallbackAllowed(runId, environmentId))) throw this.#redisOnlyMissError();
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }

    let read;
    try {
      read = await this.redis.getLatest(runId, { ...(environmentId && { environmentId }) });
    } catch (error) {
      if (!(await this.#fallbackAllowed(runId, environmentId))) throw error;
      this.#reportReadUnavailable("findLatestExecutionSnapshot", runId, error);
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }
    if (!read) {
      // A miss is the coexistence path: a pre-cutover run, or expired history. It is not an error —
      // unless the run is redis-only, where Postgres holds nothing, so a miss must throw not delegate.
      if (!(await this.#fallbackAllowed(runId, environmentId))) throw this.#redisOnlyMissError();
      this.metrics?.recordRead("findLatestExecutionSnapshot", "postgres");
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }

    // A read hit carries the run's org, so learn the mapping before hydration: this run is resident,
    // and a future read now resolves its org from memory with no DB.
    this.#prime(runId, read.entry.organizationId as string | undefined);

    if (read.danglingCycle) {
      // The entry says it has waitpoints and the cycle key holding them is gone. Serving it would
      // hand back an empty set that looks authoritative, and the run would resume with no waits.
      // Postgres still has the join rows — unless the run is redis-only, where it does not.
      if (!(await this.#fallbackAllowed(runId, environmentId))) throw this.#redisOnlyMissError();
      this.metrics?.recordRead("findLatestExecutionSnapshot", "postgres");
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }

    // Recorded AFTER hydration, not before. Hydration can fall back to Postgres, and recording
    // `redis` up front then `postgres` on the way out made one logical read increment both series.
    // Hydration is inside the boundary too. It makes a SECOND Redis call when the entry has a wait
    // cycle whose ids the read did not carry, and a failure there is the same brownout the catch
    // above exists for. Leaving it outside meant a waitpoint-bearing run still threw into the
    // engine while a plain one fell back.
    try {
      const hydrated = await this.#hydrate(read, runId, client, { hydrateWaitpointRows: true });
      this.metrics?.recordRead("findLatestExecutionSnapshot", "redis");
      return hydrated;
    } catch (error) {
      if (!(await this.#fallbackAllowed(runId, environmentId))) throw error;
      this.#reportReadUnavailable("findLatestExecutionSnapshot", runId, error);
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }
  }

  override async findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    const shape = matchSinceCursorLookup(args);
    if (!shape) {
      // A query shape Redis cannot serve. It is not a redis-only miss, so it delegates unguarded.
      return this.delegate.findExecutionSnapshot(args, client);
    }
    if (!this.readsFromRedis(shape.runId, shape.environmentId)) {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId)))
        throw this.#redisOnlyMissError();
      return this.delegate.findExecutionSnapshot(args, client);
    }

    let found;
    try {
      found = await this.redis.getById(shape.runId, shape.id, {
        ...(shape.environmentId && { environmentId: shape.environmentId }),
      });
    } catch (error) {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId))) throw error;
      this.#reportReadUnavailable("findExecutionSnapshot", shape.runId, error);
      return this.delegate.findExecutionSnapshot(args, client);
    }

    if (!found) {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId)))
        throw this.#redisOnlyMissError();
      this.metrics?.recordRead("findExecutionSnapshot", "postgres");
      return this.delegate.findExecutionSnapshot(args, client);
    }

    this.#prime(shape.runId, found.entry.organizationId as string | undefined);
    this.metrics?.recordRead("findExecutionSnapshot", "redis");
    // The engine selects createdAt only, so the answer is the cursor and nothing else.
    return {
      createdAt: new Date(found.entry.createdAt as string),
    } as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<T>;
  }

  override async findManyExecutionSnapshots<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]> {
    const shape = matchSinceWindow(args);
    if (!shape) {
      // A query shape Redis cannot serve. It is not a redis-only miss, so it delegates unguarded.
      return this.delegate.findManyExecutionSnapshots(args, client);
    }
    if (!this.readsFromRedis(shape.runId, shape.environmentId)) {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId)))
        throw this.#redisOnlyMissError();
      return this.delegate.findManyExecutionSnapshots(args, client);
    }

    let result;
    try {
      result = await this.redis.getSinceCreatedAt(shape.runId, shape.createdAt, {
        limit: shape.take,
        ...(shape.environmentId && { environmentId: shape.environmentId }),
      });
    } catch (error) {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId))) throw error;
      this.#reportReadUnavailable("findManyExecutionSnapshots", shape.runId, error);
      return this.delegate.findManyExecutionSnapshots(args, client);
    }

    if (result.kind === "miss") {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId)))
        throw this.#redisOnlyMissError();
      this.metrics?.recordRead("findManyExecutionSnapshots", "postgres");
      return this.delegate.findManyExecutionSnapshots(args, client);
    }

    // Every entry in the window is the same run, so one carries the org for the whole hit.
    this.#prime(shape.runId, result.entries[0]?.entry.organizationId as string | undefined);

    if (result.entries.some((entry) => entry.danglingCycle)) {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId)))
        throw this.#redisOnlyMissError();
      this.metrics?.recordRead("findManyExecutionSnapshots", "postgres");
      return this.delegate.findManyExecutionSnapshots(args, client);
    }

    // The engine asks for createdAt DESC and reverses app-side; the store returns ascending.
    const descending = [...result.entries].reverse();
    // Rows are hydrated for no entry here: the engine fetches the head's waitpoints itself, from
    // the ids this call's head row reports. Each row still carries its own order.
    //
    // Inside the boundary for the same reason as the sibling read: hydration can make a second Redis
    // call, and one window entry failing it must fall back rather than throw.
    try {
      const hydrated = await Promise.all(
        descending.map((entry) => this.#hydrate(entry, shape.runId, client))
      );
      // Recorded once every entry hydrated, for the same reason as the sibling read.
      this.metrics?.recordRead("findManyExecutionSnapshots", "redis");
      return hydrated as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<T>[];
    } catch (error) {
      if (!(await this.#fallbackAllowed(shape.runId, shape.environmentId))) throw error;
      this.#reportReadUnavailable("findManyExecutionSnapshots", shape.runId, error);
      return this.delegate.findManyExecutionSnapshots(args, client);
    }
  }

  override async findSnapshotCompletedWaitpointIds(
    snapshotId: string,
    client?: ReadClient,
    runId?: string
  ): Promise<string[]> {
    // Without a run id there is no keyspace to look in, so the router's fan-out is the only answer.
    if (!runId || !this.readsFromRedis(runId)) {
      if (!(await this.#fallbackAllowed(runId))) throw this.#redisOnlyMissError();
      return this.delegate.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }

    let ids;
    try {
      ids = await this.redis.getSnapshotWaitpointIds(runId, snapshotId);
    } catch (error) {
      if (!(await this.#fallbackAllowed(runId))) throw error;
      this.#reportReadUnavailable("findSnapshotCompletedWaitpointIds", runId, error);
      return this.delegate.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }
    if (!ids.present) {
      if (!(await this.#fallbackAllowed(runId))) throw this.#redisOnlyMissError();
      this.metrics?.recordRead("findSnapshotCompletedWaitpointIds", "postgres");
      return this.delegate.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }

    this.metrics?.recordRead("findSnapshotCompletedWaitpointIds", "redis");
    return ids.distinctIds;
  }

  override async findSnapshotCompletedWaitpointIdsWithPresence(
    snapshotId: string,
    client?: ReadClient,
    runId?: string
  ): Promise<{ present: boolean; ids: string[] }> {
    if (!runId || !this.readsFromRedis(runId)) {
      if (!(await this.#fallbackAllowed(runId))) throw this.#redisOnlyMissError();
      return this.delegate.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }

    let ids;
    try {
      ids = await this.redis.getSnapshotWaitpointIds(runId, snapshotId);
    } catch (error) {
      if (!(await this.#fallbackAllowed(runId))) throw error;
      this.#reportReadUnavailable("findSnapshotCompletedWaitpointIdsWithPresence", runId, error);
      return this.delegate.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }
    if (!ids.present) {
      // present=false means this reader cannot see the snapshot, so its empty list is not
      // authoritative and the engine's read-repair needs the Postgres answer — except at redis-only,
      // where Postgres holds nothing, so the miss must throw rather than serve an empty set.
      if (!(await this.#fallbackAllowed(runId))) throw this.#redisOnlyMissError();
      this.metrics?.recordRead("findSnapshotCompletedWaitpointIdsWithPresence", "postgres");
      return this.delegate.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }

    this.metrics?.recordRead("findSnapshotCompletedWaitpointIdsWithPresence", "redis");
    return { present: true, ids: ids.distinctIds };
  }

  /**
   * Turns a store entry into the Prisma payload the interface promises.
   *
   * The entry supplies every scalar column. `checkpoint` and the full waitpoint rows still live in
   * Postgres, so they are read back through the delegate — but only when the entry says they exist,
   * which keeps the common read (a running run with neither) free of any Postgres call at all.
   */
  async #hydrate(
    read: SnapshotRead,
    runId: string,
    client?: ReadClient,
    opts?: { hydrateWaitpointRows?: boolean }
  ): Promise<
    Prisma.TaskRunExecutionSnapshotGetPayload<{
      include: { completedWaitpoints: true; checkpoint: true };
    }>
  > {
    const entry = read.entry as Record<string, unknown>;

    const checkpoint = entry.checkpointId
      ? await this.#hydrateCheckpoint(runId, entry.checkpointId as string, client)
      : null;

    // `completedWaitpointOrder` is a scalar column, NOT the join. The engine reads it off the head
    // row as the index oracle that gives each completed waitpoint its position in a batch, so it
    // must be populated even when the waitpoint ROWS are not fetched. Returning an empty order here
    // resumes every batched triggerAndWait with `index: undefined`.
    // Three cases, and only the last needs a second Redis call. The read already carries the ids
    // when the store decoded them. An entry with no wait cycle has no waitpoints by construction,
    // which is the common case and used to cost a round trip to rediscover. Anything else asks.
    const ids =
      read.completedWaitpointIds ??
      (read.cycle === undefined
        ? { present: true, distinctIds: [], order: [] }
        : await this.redis.getSnapshotWaitpointIds(runId, read.id));
    const completedWaitpointOrder = ids.order;

    // The rows themselves are head-only, mirroring the engine's own N x M avoidance.
    const completedWaitpoints = opts?.hydrateWaitpointRows
      ? await this.#fetchWaitpointsInChunks(ids.distinctIds, runId, client)
      : [];

    return {
      id: read.id,
      engine: entry.engine ?? "V2",
      executionStatus: entry.executionStatus,
      description: entry.description,
      previousSnapshotId: entry.previousSnapshotId ?? null,
      runId: entry.runId,
      runStatus: entry.runStatus,
      attemptNumber: entry.attemptNumber ?? null,
      batchId: entry.batchId ?? null,
      environmentId: entry.environmentId,
      environmentType: entry.environmentType,
      projectId: entry.projectId,
      organizationId: entry.organizationId,
      checkpointId: entry.checkpointId ?? null,
      workerId: entry.workerId ?? null,
      runnerId: entry.runnerId ?? null,
      metadata: entry.metadata ?? null,
      // A column no code writes, so Postgres returns null for it on every row. The entry does not
      // carry it, and omitting it here would hand back undefined where Postgres hands back null,
      // on every single read served from Redis.
      lastHeartbeatAt: null,
      completedWaitpointOrder,
      isValid: read.isValid,
      error: entry.error ?? null,
      createdAt: new Date(entry.createdAt as string),
      // A snapshot row is write-once, so both columns hold the one instant the decorator minted.
      updatedAt: new Date(entry.createdAt as string),
      checkpoint,
      completedWaitpoints,
    } as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<{
      include: { completedWaitpoints: true; checkpoint: true };
    }>;
  }

  /**
   * Chunked, and bounded within each chunk, mirroring the engine's own waitpoint fetch. The run id
   * routes each chunk to the owning store rather than fanning every one across both databases.
   */
  async #fetchWaitpointsInChunks(
    waitpointIds: string[],
    runId: string,
    client?: ReadClient
  ): Promise<unknown[]> {
    if (waitpointIds.length === 0) return [];

    const all: unknown[] = [];
    for (let i = 0; i < waitpointIds.length; i += WAITPOINT_CHUNK_SIZE) {
      const chunk = waitpointIds.slice(i, i + WAITPOINT_CHUNK_SIZE);
      const rows = await this.delegate.findManyWaitpoints(
        { where: { id: { in: boundedIn(chunk) } } },
        client,
        runId
      );
      all.push(...rows);
    }
    return all;
  }

  /**
   * Reads the checkpoint row through the snapshot the delegate still holds, so the read stays
   * residency-aware: the run id in the where is what routes it to the owning database, and the
   * decorator sits above the router and has no client of its own.
   *
   * At `redis-only` the Postgres snapshot row is gone, so this returns null. The checkpoint row
   * itself stays in Postgres, but the interface has no residency-aware way to read one directly.
   * Closing that needs a narrow lookup on the interface, which the plan freezes for this ticket.
   */
  async #hydrateCheckpoint(
    runId: string,
    checkpointId: string,
    client?: ReadClient
  ): Promise<unknown> {
    // Read the checkpoint ROW directly by id, NOT via the snapshot row: at redis-only the snapshot
    // row is suppressed, so hydrating through it returns null and a resumed run loses its checkpoint.
    // The TaskRunCheckpoint row is never suppressed. runId routes to the run's co-located store.
    return this.delegate.findTaskRunCheckpointById(checkpointId, runId, client);
  }

  async #enqueueRepair(entry: SnapshotEntryInput): Promise<void> {
    if (!this.onAppendFailure) {
      return;
    }

    try {
      await this.onAppendFailure({
        runId: entry.runId,
        snapshotId: entry.id,
        executionStatus: entry.executionStatus,
      });
    } catch (error) {
      // The repair enqueue is itself best-effort. Failing it must not fail the caller's write.
      this.logger.error("snapshot repair enqueue failed", { runId: entry.runId, error });
    }
  }
}

/**
 * A mirror head with no readable timestamp cannot be shown to be newer, so the repair proceeds. The
 * alternative is refusing on an unparseable value, which would strand the run with a stale head.
 */
function headIsNewerThan(head: SnapshotRead, createdAt: Date): boolean {
  const raw = head.entry["createdAt"];
  if (typeof raw !== "string") {
    return false;
  }
  const headMs = Date.parse(raw);
  return Number.isFinite(headMs) && headMs > createdAt.getTime();
}

/** Position-sensitive: the same ids in a different order are a different wait cycle. */
function sameOrder(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Turns the lock site's two lists into cycle refs. `completedWaitpointIds` is the complete set the
 * delegate connects; `completedWaitpointOrder` gives a position only to the ids that have one, and a
 * repeated id keeps each of its positions.
 */
function lockCycleRefs(ids: string[], order: string[]): { id: string; index?: number }[] {
  const refs: { id: string; index?: number }[] = [];
  const indexed = new Set<string>();

  order.forEach((id, index) => {
    refs.push({ id, index });
    indexed.add(id);
  });

  for (const id of ids) {
    if (!indexed.has(id)) refs.push({ id });
  }

  return refs;
}

/** Membership only, for the id set, which has no meaningful order. */
function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((id) => seen.has(id));
}
