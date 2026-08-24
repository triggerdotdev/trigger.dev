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
import type { RedisSnapshotStore, SnapshotEntryInput } from "./redisSnapshotStore.js";
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
import type { Prisma, PrismaClientOrTransaction, TaskRun } from "@trigger.dev/database";

/** One initial attempt plus three retries, per the write protocol. */
const APPEND_ATTEMPTS = 4;

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
  staging?: SnapshotEntryInput[];
};

export class TaskRunExecutionSnapshotStore extends DelegatingRunStore {
  readonly mode: SnapshotStoreMode;
  protected readonly redis: RedisSnapshotStore;
  protected readonly readPercent: number;
  protected readonly onAppendFailure?: SnapshotRepairEnqueuer;
  protected readonly faults?: SnapshotFaultInjector;
  protected readonly metrics?: DecoratorMetrics;
  protected readonly logger: Logger;
  protected readonly staging?: SnapshotEntryInput[];

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

    const staged: SnapshotEntryInput[] = [];

    const result = await this.delegate.runInTransaction(runId, (store, tx) =>
      fn(this.#wrap(store, staged), tx)
    );

    // The transaction committed. Only now can a snapshot claim its partner is durable.
    for (const entry of staged) {
      await this.#appendTransition("runInTransaction", entry);
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

    return this.#wrap(store);
  }

  /**
   * A second decorator over another store, sharing this one's options. One class in both roles keeps
   * the write-ordering logic in exactly one place. Passing no buffer gives a plain decorator that
   * appends immediately; passing one makes it stage instead.
   */
  #wrap(store: RunStore, staging?: SnapshotEntryInput[]): TaskRunExecutionSnapshotStore {
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
    const snapshot = { ...params.snapshot, id: ctx.id };

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
    const snapshot = { ...params.snapshot, id: ctx.id };

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
    const withId = { ...data, snapshot: { ...data.snapshot, id: ctx.id } };

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
    const withId = { ...data, snapshot: { ...data.snapshot, id: ctx.id } };

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
    const withId = { ...data, snapshot: { ...data.snapshot, id: ctx.id } };

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
    const withId = { ...data, snapshot: { ...data.snapshot, id: ctx.id } };

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

    const result = await this.delegate.lockRunToWorker(runId, data, tx);

    await this.#appendTransition(
      "lockRunToWorker",
      entryFromLock(ctx, data.snapshot),
      data.snapshot.previousSnapshotId
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
    const created = await this.delegate.createExecutionSnapshot({ ...input, id: ctx.id }, tx);

    // The standalone path is the only one whose delegate returns the row, so its entry can take the
    // exact createdAt Postgres recorded rather than the decorator's own clock.
    await this.#appendTransition(
      "createExecutionSnapshot",
      entryFromCreateExecutionSnapshot({ ...ctx, createdAt: created.createdAt }, input),
      input.previousSnapshotId
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
    expectedCur?: string
  ): Promise<void> {
    if (this.staging) {
      // Inside a transaction the append cannot run until the Postgres side commits, or a rollback
      // leaves Redis holding a transition that never happened.
      this.staging.push(entry);
      return;
    }

    for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt++) {
      try {
        this.faults?.(attempt === 0 ? "afterPgBeforeRedis" : "midFlushRetry", {
          runId: entry.runId,
          snapshotId: entry.id,
        });

        const result = await this.redis.append({
          entry,
          kind: "transition",
          isTerminal: isTerminalEntry(entry),
          ...(expectedCur !== undefined && { expectedCur }),
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
