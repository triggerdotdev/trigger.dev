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

/**
 * Matches the engine's own chunked waitpoint fetch. A batch can complete a thousand waitpoints at
 * once, and an unbounded `in:` makes each distinct list length its own prepared statement.
 */
const WAITPOINT_CHUNK_SIZE = 100;

/**
 * The rollout dial. Postgres stays fully written and authoritative in every position before
 * `redis-only`, so every earlier position rolls back losslessly by turning the dial down.
 *
 * `compare` writes exactly as `dual-write` does. Its sampled dual-read and diff are a later ticket;
 * the position is named here so the dial does not have to widen once that lands.
 */
export type SnapshotStoreMode = "off" | "dual-write" | "compare" | "redis-read" | "redis-only";

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

export type DecoratorMetrics = {
  recordWrite(site: string, outcome: string): void;
  recordAppendFailed(site: string): void;
  recordRead(method: string, source: "redis" | "postgres"): void;
};

export type TaskRunExecutionSnapshotStoreOptions = {
  store: RedisSnapshotStore;
  /** Defaults to `off`, which is a pure pass-through that never touches Redis. */
  mode?: SnapshotStoreMode;
  /** Percentage of runs whose reads come from Redis at `redis-read` and `redis-only`. Defaults to 0. */
  readPercent?: number;
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
  readonly mode: SnapshotStoreMode;
  protected readonly redis: RedisSnapshotStore;
  protected readonly readPercent: number;
  protected readonly onAppendFailure?: SnapshotRepairEnqueuer;
  protected readonly faults?: SnapshotFaultInjector;
  protected readonly metrics?: DecoratorMetrics;
  protected readonly logger: Logger;
  protected readonly staging?: StagedAppend[];

  constructor(delegate: RunStore, options: TaskRunExecutionSnapshotStoreOptions) {
    super(delegate);
    this.redis = options.store;
    this.mode = options.mode ?? "off";
    this.readPercent = options.readPercent ?? 0;
    this.onAppendFailure = options.onAppendFailure;
    this.faults = options.faults;
    this.metrics = options.metrics;
    this.logger = options.logger ?? new Logger("TaskRunExecutionSnapshotStore", "debug");
    this.staging = options.staging;
  }

  /** True in every position that appends to Redis. */
  protected get writesRedis(): boolean {
    return this.mode !== "off";
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
    if (!this.writesRedis) {
      // At `off` the callback must receive the delegate's own store, untouched, so a transaction
      // behaves exactly as it does without the decorator in the chain.
      return this.delegate.runInTransaction(runId, fn);
    }

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

    if (!this.writesRedis) {
      return store;
    }

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
      mode: this.mode,
      readPercent: this.readPercent,
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
    if (!this.writesRedis) {
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
    if (!this.writesRedis) {
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
    if (!this.writesRedis) {
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
    if (!this.writesRedis) {
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
    if (!this.writesRedis) {
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
    if (!this.writesRedis || !data.snapshot) {
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
    if (!this.writesRedis) {
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
    if (!this.writesRedis) {
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
        this.#recordOutcome(site, entry, result);

        // Modelled AFTER the successful append: the crash this boundary represents is a process that
        // died between the two stores, not an append that failed.
        this.faults?.("afterRedisBirthBeforePg", { runId: entry.runId, snapshotId: entry.id });
        return;
      } catch (error) {
        if (isInjectedFault(error)) {
          throw error;
        }

        if (attempt === APPEND_ATTEMPTS - 1) {
          this.metrics?.recordAppendFailed(site);
          this.logger.error("snapshot birth append failed after retries", {
            runId: entry.runId,
            snapshotId: entry.id,
            site,
            mode: this.mode,
            error,
          });

          if (this.mode === "redis-only") {
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

        this.#recordOutcome(site, entry, result);
        return;
      } catch (error) {
        // An injected fault models a dead process, not a retryable append failure.
        if (isInjectedFault(error)) {
          this.metrics?.recordAppendFailed(site);
          await this.#enqueueRepair(entry);
          return;
        }

        if (attempt === APPEND_ATTEMPTS - 1) {
          this.metrics?.recordAppendFailed(site);
          this.logger.error("snapshot append failed after retries", {
            runId: entry.runId,
            snapshotId: entry.id,
            site,
            error,
          });
          await this.#enqueueRepair(entry);
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
      }
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
   * None of the four append outcomes is a failure, and none of them enqueues a repair.
   *
   * `skippedNoKeyspace` is every pre-cutover run's transitions. `forked` means another writer
   * advanced the head, which a repair cannot help. `duplicate` is a retry that already landed.
   * `cycleMismatch` means the store refused an untrustworthy waitpoint pointer on purpose.
   */
  #recordOutcome(
    site: string,
    entry: SnapshotEntryInput,
    result: Awaited<ReturnType<RedisSnapshotStore["append"]>>
  ): void {
    this.metrics?.recordWrite(site, result.outcome);

    if (result.outcome === "forked") {
      this.logger.warn("snapshot append forked", {
        runId: entry.runId,
        snapshotId: entry.id,
        site,
        actualCur: result.actualCur,
      });
    }
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
  protected readsFromRedis(runId: string): boolean {
    if (this.mode !== "redis-read" && this.mode !== "redis-only") return false;

    // At `redis-only` the cohort dial has no meaning. Postgres holds no snapshot rows at that
    // position, so a run routed away from Redis reads nothing at all. Ignoring the percentage here
    // makes that misconfiguration unreachable rather than merely documented.
    if (this.mode === "redis-only") return true;

    if (this.readPercent >= 100) return true;
    if (this.readPercent <= 0) return false;

    let hash = 0;
    for (let i = 0; i < runId.length; i++) {
      hash = (hash * 31 + runId.charCodeAt(i)) >>> 0;
    }
    return hash % 100 < this.readPercent;
  }

  override async findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient,
    environmentId?: string
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{
    include: { completedWaitpoints: true; checkpoint: true };
  }> | null> {
    if (!this.readsFromRedis(runId)) {
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }

    const read = await this.redis.getLatest(runId, { ...(environmentId && { environmentId }) });
    if (!read) {
      // A miss is the coexistence path: a pre-cutover run, or expired history. It is not an error.
      this.metrics?.recordRead("findLatestExecutionSnapshot", "postgres");
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }

    if (read.danglingCycle) {
      // The entry says it has waitpoints and the cycle key holding them is gone. Serving it would
      // hand back an empty set that looks authoritative, and the run would resume with no waits.
      // Postgres still has the join rows.
      this.metrics?.recordRead("findLatestExecutionSnapshot", "postgres");
      return this.delegate.findLatestExecutionSnapshot(runId, client, environmentId);
    }

    this.metrics?.recordRead("findLatestExecutionSnapshot", "redis");
    return this.#hydrate(read, runId, client, { hydrateWaitpointRows: true });
  }

  override async findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    const shape = matchSinceCursorLookup(args);
    if (!shape || !this.readsFromRedis(shape.runId)) {
      return this.delegate.findExecutionSnapshot(args, client);
    }

    const found = await this.redis.getById(shape.runId, shape.id, {
      ...(shape.environmentId && { environmentId: shape.environmentId }),
    });

    if (!found) {
      this.metrics?.recordRead("findExecutionSnapshot", "postgres");
      return this.delegate.findExecutionSnapshot(args, client);
    }

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
    if (!shape || !this.readsFromRedis(shape.runId)) {
      return this.delegate.findManyExecutionSnapshots(args, client);
    }

    const result = await this.redis.getSinceCreatedAt(shape.runId, shape.createdAt, {
      limit: shape.take,
      ...(shape.environmentId && { environmentId: shape.environmentId }),
    });

    if (result.kind === "miss") {
      this.metrics?.recordRead("findManyExecutionSnapshots", "postgres");
      return this.delegate.findManyExecutionSnapshots(args, client);
    }

    if (result.entries.some((entry) => entry.danglingCycle)) {
      this.metrics?.recordRead("findManyExecutionSnapshots", "postgres");
      return this.delegate.findManyExecutionSnapshots(args, client);
    }

    this.metrics?.recordRead("findManyExecutionSnapshots", "redis");

    // The engine asks for createdAt DESC and reverses app-side; the store returns ascending.
    const descending = [...result.entries].reverse();
    // Rows are hydrated for no entry here: the engine fetches the head's waitpoints itself, from
    // the ids this call's head row reports. Each row still carries its own order.
    const hydrated = await Promise.all(
      descending.map((entry) => this.#hydrate(entry, shape.runId, client))
    );
    return hydrated as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<T>[];
  }

  override async findSnapshotCompletedWaitpointIds(
    snapshotId: string,
    client?: ReadClient,
    runId?: string
  ): Promise<string[]> {
    // Without a run id there is no keyspace to look in, so the router's fan-out is the only answer.
    if (!runId || !this.readsFromRedis(runId)) {
      return this.delegate.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }

    const ids = await this.redis.getSnapshotWaitpointIds(runId, snapshotId);
    if (!ids.present) {
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
      return this.delegate.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }

    const ids = await this.redis.getSnapshotWaitpointIds(runId, snapshotId);
    if (!ids.present) {
      // present=false means this reader cannot see the snapshot, so its empty list is not
      // authoritative and the engine's read-repair needs the Postgres answer.
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
      ? await this.#hydrateCheckpoint(runId, read.id, client)
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
    snapshotId: string,
    client?: ReadClient
  ): Promise<unknown> {
    const row = await this.delegate.findExecutionSnapshot(
      { where: { id: snapshotId, runId }, include: { checkpoint: true } },
      client
    );
    return (row as { checkpoint?: unknown } | null)?.checkpoint ?? null;
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
