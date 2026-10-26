// The snapshot-store decorator.
//
// Each write runs PREPARE, COMMIT, FINALIZE. Inside the owning Postgres transaction it prepares the
// unit in MemoryDB, hidden from reads. After COMMIT, finalize makes all the unit's entries visible
// at once. A mirrored run writes TaskRun and TRES rows. A redis-primary run writes no TRES row: its
// snapshots and completed-waitpoint cycles live in MemoryDB alone.
//
// Reads dispatch on the run's durable residency, not the dial. A redis-primary run always reads
// MemoryDB and fails closed, even at a lowered dial, so a lower dial loses nothing. The dial sets
// only a mirrored run's read preference.

import type {
  Prisma,
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskRun,
  TaskRunExecutionStatus,
  TaskRunStatus,
} from "@trigger.dev/database";
import { boundedIn } from "@trigger.dev/database";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import { generateInternalId } from "@trigger.dev/core/v3/isomorphic";
import { DelegatingRunStore } from "./delegatingRunStore.js";
import type {
  CompletionSnapshotInput,
  CreateCancelledRunInput,
  CreateExecutionSnapshotInput,
  CreateRunInput,
  ExpireSnapshotInput,
  LatestExecutionSnapshotRead,
  LockRunData,
  ReadClient,
  SnapshotReadWaitpoint,
  RescheduleSnapshotInput,
  RunStore,
  TaskRunWithWaitpoint,
} from "./types.js";
import { deriveDistinctIds, deriveOrder } from "./redisSnapshotStore.js";
import type {
  AppendCyclePayload,
  CompletedWaitpointRecord,
  CompletedWaitpointResolver,
  CompletedWaitpointsRead,
  FinalizeResult,
  GetSinceResult,
  PreparedEntry,
  PreparedPgUnit,
  RedisSnapshotStore,
  SnapshotRead,
} from "./redisSnapshotStore.js";
import {
  entryFromCompletion,
  entryFromCreateExecutionSnapshot,
  entryFromCreateRun,
  entryFromExpire,
  entryFromLock,
  entryFromReschedule,
  isTerminalEntry,
} from "./snapshotEntry.js";
import { SnapshotResidencyResolver } from "./snapshotResidencyResolver.js";
import {
  parseSnapshotRoute,
  metadataWithSnapshotResidency,
  snapshotResidencyFromMetadata,
  snapshotRouteFromSnapshot,
  type SnapshotReadContext,
  type SnapshotRoute,
} from "./snapshotResidency.js";

const PROTOCOL_VERSION = 1;

/**
 * The enrolled dial positions. `dual-write` mirrors writes and reads Postgres. `redis-read` also
 * reads a mirrored run's head from MemoryDB; completed-waitpoint links stay in Postgres.
 * `redis-only` mints redis-primary runs, which read MemoryDB with no Postgres fallback.
 */
export type TaskRunExecutionSnapshotStoreMode = "dual-write" | "redis-read" | "redis-only";

/** A per-org dial position. At `off`, or with no value, new runs are born in Postgres. */
export type SnapshotStoreDial = "off" | TaskRunExecutionSnapshotStoreMode;

// "unavailable:<kind>" fails closed retriably; "expired" fails closed for good.
type SnapshotReadPlan =
  | "postgres"
  | "mirrored"
  | "redisPrimary"
  | `unavailable:${SnapshotResidencyUnavailableKind}`
  | "expired";

type SnapshotResidencyUnavailableKind = "error" | "pendingBirth";

const RESIDENCY_UNAVAILABLE_REASON: Record<SnapshotResidencyUnavailableKind, string> = {
  error: "residency read failed",
  pendingBirth: "birth pending",
};

function isUnavailablePlan(
  plan: SnapshotReadPlan
): plan is `unavailable:${SnapshotResidencyUnavailableKind}` {
  return plan.startsWith("unavailable:");
}

function residencyUnavailableError(
  runId: string,
  plan: `unavailable:${SnapshotResidencyUnavailableKind}`
): SnapshotReadUnavailableError {
  const kind = plan.slice("unavailable:".length) as SnapshotResidencyUnavailableKind;
  return new SnapshotReadUnavailableError(runId, RESIDENCY_UNAVAILABLE_REASON[kind], { kind });
}

const FINALIZE_OUTCOME_UNKNOWN =
  "finalize outcome unknown after Postgres commit; the recovery worker owns the pending unit";

// Adds a short cause summary, so a logged message names the failure without a stack.
function reasonWithCause(reason: string, cause: unknown): string {
  if (cause === undefined) return reason;
  const summary = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
  return `${reason}: ${summary.slice(0, 200)}`;
}

/**
 * A snapshot read that MemoryDB cannot serve authoritatively now: a MemoryDB error, an unsettled
 * pending unit, a quarantine, or a missing redis-primary entry. RETRIABLE: the caller retries and
 * never reads a possibly stale Postgres head instead.
 */
export class SnapshotReadUnavailableError extends Error {
  readonly retriable: boolean = true;
  readonly runId: string;
  readonly reason: string;
  readonly cause?: unknown;
  /** Set when the read failed closed on the residency resolver's outcome. */
  readonly kind?: SnapshotResidencyUnavailableKind;
  constructor(
    runId: string,
    reason: string,
    options?: { cause?: unknown; kind?: SnapshotResidencyUnavailableKind }
  ) {
    super(`snapshot read unavailable for ${runId}: ${reasonWithCause(reason, options?.cause)}`);
    this.name = "SnapshotReadUnavailableError";
    this.runId = runId;
    this.reason = reason;
    this.cause = options?.cause;
    this.kind = options?.kind;
  }
}

/**
 * A redis-primary run whose MemoryDB state has expired. Only a FINISHED entry arms the TTL, so the
 * state never comes back: NOT retriable. It extends SnapshotReadUnavailableError, so fail-closed
 * callers still fail closed.
 */
export class SnapshotStateExpiredError extends SnapshotReadUnavailableError {
  override readonly retriable = false;
  constructor(runId: string) {
    super(runId, "state expired");
    this.name = "SnapshotStateExpiredError";
  }
}

/**
 * A snapshot write that failed closed. RETRIABLE.
 *
 * `phase: "transaction"` (the default): it failed before COMMIT, so nothing it wrote persists.
 * `phase: "finalize"`: Postgres committed and only the finalize is unproven. Do not redo the whole
 * operation, or it writes the Postgres rows twice.
 */
export class SnapshotWriteUnavailableError extends Error {
  readonly retriable = true;
  readonly runId: string;
  readonly cause?: unknown;
  readonly phase: "transaction" | "finalize";
  constructor(
    runId: string,
    reason: string,
    options?: { cause?: unknown; phase?: "transaction" | "finalize" }
  ) {
    super(`snapshot write unavailable for ${runId}: ${reasonWithCause(reason, options?.cause)}`);
    this.name = "SnapshotWriteUnavailableError";
    this.runId = runId;
    this.cause = options?.cause;
    this.phase = options?.phase ?? "transaction";
  }
}

// Rolls the owning transaction back on a busy prepare, so its connection is free before recovery
// reads Postgres (see #runInTransaction). Never escapes the decorator.
class PendingUnitBusyError extends Error {
  constructor(runId: string) {
    super(`snapshot prepare busy for ${runId}`);
    this.name = "PendingUnitBusyError";
  }
}

/** Decorator metrics. Every label is a fixed enum, never an org id. */
export type SnapshotDecoratorMetrics = {
  // One per pending unit. "forked" is a fork-guard rejection; "failed" is a failed prepare or
  // finalize.
  recordWrite(outcome: "written" | "forked" | "failed"): void;
  recordReadSource(source: "redis" | "postgres"): void;
};

/** Reuse one flag result within a read operation, never across requests. */
type ResolvedSnapshotDial = { organizationId: string; dial: SnapshotStoreDial | undefined };

export type TaskRunExecutionSnapshotStoreOptions = {
  store: RedisSnapshotStore | (() => RedisSnapshotStore);
  metrics?: SnapshotDecoratorMetrics;
  /**
   * The dial for births and mirrored reads when `resolveDial` is absent. In production a shared
   * store serves many orgs, so `resolveDial` overrides this per run.
   */
  mode: TaskRunExecutionSnapshotStoreMode;
  /**
   * The org's current dial. It sets a new run's residency and a mirrored run's read preference. It
   * never changes an existing run's residency, so a stale flag cannot move a run between stores.
   */
  resolveDial?: (
    organizationId: string,
    organizationFlags?: unknown
  ) => SnapshotStoreDial | undefined | Promise<SnapshotStoreDial | undefined>;
  /** Uncached. Defaults to a resolver over the lazy MemoryDB source. */
  residencyResolver?: SnapshotResidencyResolver;
  /** The unit's org, when the caller carries a trusted one; else taken from the snapshot. */
  organizationId?: string;
  /** The store route the recovery worker uses to reach the owning primary. */
  logicalRunStoreRoute: string;
  /** Overridable for deterministic tests. */
  generateTransitionToken?: () => string;
  /**
   * Settles a run's pending unit from `pg_xact_status`. The unit stays pending only while its
   * transaction is in progress. With `requireSettledTransaction`, only a proven outcome is acted
   * on.
   */
  resolvePending?: (
    runId: string,
    options?: { requireSettledTransaction?: boolean }
  ) => Promise<void>;
  /**
   * Expands a completed-waitpoint cycle's records into `CompletedWaitpoint[]`. It lives in
   * run-engine because a `deriveFromRun` record needs a Postgres read. Required to read a
   * redis-primary snapshot that has completed waitpoints.
   */
  resolveCompletedWaitpoints?: CompletedWaitpointResolver;
  /** As `resolveCompletedWaitpoints`, with the trusted org from the snapshot entry already read. */
  resolveCompletedWaitpointsWithContext?: (
    args: Parameters<CompletedWaitpointResolver>[0],
    context: { organizationId: string }
  ) => ReturnType<CompletedWaitpointResolver>;
  /**
   * Returns the owning store's primary, to load a mirrored head row that the caller's replica does
   * not have yet. `undefined` makes that miss fail retriably instead of returning null.
   */
  resolvePrimaryReadClient?: (runId: string) => ReadClient | undefined;
  /**
   * Read at birth only. When false, a `redis-only` birth is capped to `mirrored`, so it cannot
   * strand a redis-primary run. Default: always ready.
   */
  redisPrimaryBirthReady?: () => boolean;
  /**
   * Fault-injection seams for tests. A throw in `afterPrepare` (before COMMIT) rolls back and
   * aborts the unit. A throw in `beforeFinalize` (after COMMIT) simulates a crash and leaves the
   * pending unit for recovery.
   */
  hooks?: {
    afterPrepare?: () => void | Promise<void>;
    beforeFinalize?: () => void | Promise<void>;
  };
};

type CollectedEntry = {
  entry: PreparedEntry;
  organizationId: string;
  residency: "mirrored" | "redis-primary";
};

type CaptureDeps = {
  runId: string;
  organizationId?: string;
  // Every Postgres write MUST run on this transaction, or a later throw cannot roll it back.
  tx: PrismaClientOrTransaction;
  collect: (c: CollectedEntry) => void;
  resolveResidency: (
    organizationId: string,
    kind: "birth" | "transition",
    routeField?: unknown,
    organizationFlags?: unknown
  ) => Promise<"postgres" | "mirrored" | "redis-primary">;
  mint: <S extends { id?: string; createdAt?: Date }>(s: S) => S;
  applyRedisControl: <S extends { writeSnapshotRow?: boolean }>(
    s: S,
    r: "mirrored" | "redis-primary"
  ) => S;
  buildCycle: (
    cw: { id: string; index?: number }[] | undefined,
    resolveRecords: (() => Promise<CompletedWaitpointRecord[]>) | undefined,
    r: "mirrored" | "redis-primary"
  ) => Promise<AppendCyclePayload | undefined>;
};

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The store an owning transaction's callback writes through. It writes each snapshot to Postgres on
 * `tx` and collects its staged entry, and #runInTransaction prepares them as one unit. A postgres
 * run collects nothing. Residency is resolved once, on the first snapshot write: one unit is one
 * run.
 */
class CapturingTxStore extends DelegatingRunStore {
  #residency?: "postgres" | "mirrored" | "redis-primary";
  constructor(
    delegate: RunStore,
    private readonly deps: CaptureDeps
  ) {
    super(delegate);
  }

  async #residencyFor(
    organizationId: string,
    kind: "birth" | "transition",
    routeField?: unknown,
    organizationFlags?: unknown
  ): Promise<"postgres" | "mirrored" | "redis-primary"> {
    if (this.#residency !== undefined) return this.#residency;
    this.#residency = await this.deps.resolveResidency(
      organizationId,
      kind,
      routeField,
      organizationFlags
    );
    return this.#residency;
  }

  // Runs before any Postgres write, so a write for another run is rejected, not mixed into this
  // unit.
  #assertBoundRun(actualRunId: string): void {
    if (actualRunId !== this.deps.runId) {
      throw new Error(
        `snapshot write for run ${actualRunId} inside a transaction bound to ${this.deps.runId}: one prepared unit is exactly one run`
      );
    }
  }

  override async createRun(
    params: CreateRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const runId = params.data.id;
    const organizationId = this.deps.organizationId ?? params.snapshot.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(
      organizationId,
      "birth",
      undefined,
      params.organizationFlags
    );
    if (residency === "postgres") {
      // Defensive: the outer createRun handles a postgres birth before runInTransaction.
      return super.createRun(params, this.deps.tx);
    }
    const snapshot = this.deps.applyRedisControl(this.deps.mint(params.snapshot), residency);
    const result = await super.createRun({ ...params, snapshot }, this.deps.tx);
    // The trigger path stamps this snapshot route on the first enqueue, with no lookup.
    params.onBirthResidency?.({ runId, organizationId, residency });
    const entry = entryFromCreateRun(
      { id: snapshot.id!, runId, createdAt: snapshot.createdAt! },
      snapshot
    );
    this.deps.collect({
      // A birth asserts an empty head, so a second birth on the same run forks.
      entry: { entry, kind: "birth", isTerminal: isTerminalEntry(entry), expectedCur: "" },
      organizationId,
      residency,
    });
    return result;
  }

  override async createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    const runId = input.run.id;
    const organizationId = this.deps.organizationId ?? input.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(organizationId, "transition", input.snapshotRoute);
    if (residency === "postgres") return super.createExecutionSnapshot(input, this.deps.tx);
    const id = input.id ?? generateInternalId();
    const createdAt = input.createdAt ?? new Date();
    const withIds = this.deps.applyRedisControl({ ...input, id, createdAt }, residency);
    const result = await super.createExecutionSnapshot(withIds, this.deps.tx);
    const entry = entryFromCreateExecutionSnapshot({ id, runId, createdAt }, withIds);
    const cycle = await this.deps.buildCycle(
      input.completedWaitpoints,
      input.resolveCompletedWaitpointRecords,
      residency
    );
    this.deps.collect({
      // Fork guard: the head must be the previous snapshot. Later entries chain against their
      // predecessor.
      entry: {
        entry,
        kind: "transition",
        isTerminal: isTerminalEntry(entry),
        cycle,
        ...(input.previousSnapshotId !== undefined && { expectedCur: input.previousSnapshotId }),
      },
      organizationId,
      residency,
    });
    return result;
  }

  override async lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>> {
    const organizationId = this.deps.organizationId ?? data.snapshot.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") return super.lockRunToWorker(runId, data, this.deps.tx);
    const createdAt = data.snapshot.createdAt ?? new Date();
    const snapshot = this.deps.applyRedisControl({ ...data.snapshot, createdAt }, residency);
    const result = await super.lockRunToWorker(runId, { ...data, snapshot }, this.deps.tx);
    const entry = entryFromLock({ id: snapshot.id, runId, createdAt }, snapshot);
    // A resume lock carries the head's completed-waitpoint cycle forward, with no records resolver.
    // Rebuild the refs exactly: each indexed order position, duplicates kept (e.g. [A,B,A]), then
    // each distinct unindexed id. A per-id map would collapse repeated indices.
    const inOrder = new Set(snapshot.completedWaitpointOrder);
    const seenUnindexed = new Set<string>();
    const completedWaitpoints: { id: string; index?: number }[] =
      snapshot.completedWaitpointOrder.map((id, index) => ({ id, index }));
    for (const id of snapshot.completedWaitpointIds) {
      if (inOrder.has(id) || seenUnindexed.has(id)) continue;
      seenUnindexed.add(id);
      completedWaitpoints.push({ id });
    }
    const cycle = await this.deps.buildCycle(completedWaitpoints, undefined, residency);
    this.deps.collect({
      entry: {
        entry,
        kind: "transition",
        isTerminal: isTerminalEntry(entry),
        cycle,
        ...(snapshot.previousSnapshotId !== undefined && {
          expectedCur: snapshot.previousSnapshotId,
        }),
      },
      organizationId,
      residency,
    });
    return result;
  }

  // A cancellation creates the run with its terminal snapshot, so it is a birth, as in createRun.
  override async createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const runId = params.data.id;
    const organizationId = this.deps.organizationId ?? params.snapshot.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(
      organizationId,
      "birth",
      undefined,
      params.organizationFlags
    );
    if (residency === "postgres") return super.createCancelledRun(params, this.deps.tx);
    const snapshot = this.deps.applyRedisControl(this.deps.mint(params.snapshot), residency);
    const result = await super.createCancelledRun({ ...params, snapshot }, this.deps.tx);
    const entry = entryFromCreateRun(
      { id: snapshot.id!, runId, createdAt: snapshot.createdAt! },
      snapshot
    );
    this.deps.collect({
      entry: { entry, kind: "birth", isTerminal: isTerminalEntry(entry), expectedCur: "" },
      organizationId,
      residency,
    });
    return result;
  }

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
    const organizationId = this.deps.organizationId ?? data.snapshot.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") {
      return super.completeAttemptSuccess(runId, data, args, this.deps.tx);
    }
    const id = data.snapshot.id ?? generateInternalId();
    const createdAt = data.snapshot.createdAt ?? new Date();
    const snapshot = this.deps.applyRedisControl({ ...data.snapshot, id, createdAt }, residency);
    const result = await super.completeAttemptSuccess(
      runId,
      { ...data, snapshot },
      args,
      this.deps.tx
    );
    const entry = entryFromCompletion({ id, runId, createdAt }, snapshot);
    this.deps.collect({
      entry: { entry, kind: "transition", isTerminal: isTerminalEntry(entry) },
      organizationId,
      residency,
    });
    return result;
  }

  override async expireRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      error: TaskRunError;
      completedAt: Date;
      expiredAt: Date;
      snapshot: ExpireSnapshotInput;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const organizationId = this.deps.organizationId ?? data.snapshot.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") return super.expireRun(runId, data, args, this.deps.tx);
    const id = data.snapshot.id ?? generateInternalId();
    const createdAt = data.snapshot.createdAt ?? new Date();
    const snapshot = this.deps.applyRedisControl({ ...data.snapshot, id, createdAt }, residency);
    const result = await super.expireRun(runId, { ...data, snapshot }, args, this.deps.tx);
    const entry = entryFromExpire({ id, runId, createdAt }, snapshot);
    this.deps.collect({
      entry: { entry, kind: "transition", isTerminal: isTerminalEntry(entry) },
      organizationId,
      residency,
    });
    return result;
  }

  // `count: 0` means the run was not PENDING_VERSION and no snapshot was written: collect nothing.
  override async expireParkedRun(
    runId: string,
    data: {
      error: TaskRunError;
      completedAt: Date;
      expiredAt: Date;
      statusReason: string;
      snapshot: ExpireSnapshotInput;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    const organizationId = this.deps.organizationId ?? data.snapshot.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") return super.expireParkedRun(runId, data, this.deps.tx);
    const id = data.snapshot.id ?? generateInternalId();
    const createdAt = data.snapshot.createdAt ?? new Date();
    const snapshot = this.deps.applyRedisControl({ ...data.snapshot, id, createdAt }, residency);
    const result = await super.expireParkedRun(runId, { ...data, snapshot }, this.deps.tx);
    if (result.count === 0) return result;
    const entry = entryFromExpire({ id, runId, createdAt }, snapshot);
    this.deps.collect({
      entry: { entry, kind: "transition", isTerminal: isTerminalEntry(entry) },
      organizationId,
      residency,
    });
    return result;
  }

  // A delay update with no `data.snapshot` writes no snapshot: it passes through and collects
  // nothing.
  override async rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    this.#assertBoundRun(runId);
    if (data.snapshot === undefined) return super.rescheduleRun(runId, data, this.deps.tx);
    const snapshotInput = data.snapshot;
    const organizationId = this.deps.organizationId ?? snapshotInput.organizationId;
    const residency = await this.#residencyFor(
      organizationId,
      "transition",
      snapshotInput.snapshotRoute
    );
    if (residency === "postgres") return super.rescheduleRun(runId, data, this.deps.tx);
    const id = snapshotInput.id ?? generateInternalId();
    const createdAt = snapshotInput.createdAt ?? new Date();
    const snapshot = this.deps.applyRedisControl({ ...snapshotInput, id, createdAt }, residency);
    const result = await super.rescheduleRun(runId, { ...data, snapshot }, this.deps.tx);
    const entry = entryFromReschedule({ id, runId, createdAt }, snapshot);
    this.deps.collect({
      entry: { entry, kind: "transition", isTerminal: isTerminalEntry(entry) },
      organizationId,
      residency,
    });
    return result;
  }
}

// A lookup with no `where.runId` cannot be dispatched by residency and passes through to Postgres.
function runIdFromWhere(where: unknown): string | undefined {
  const runId = (where as { runId?: unknown } | null | undefined)?.runId;
  return typeof runId === "string" ? runId : undefined;
}

function snapshotIdFromWhere(where: unknown): string | undefined {
  const id = (where as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

function environmentIdFromWhere(where: unknown): string | undefined {
  const environmentId = (where as { environmentId?: unknown } | null | undefined)?.environmentId;
  return typeof environmentId === "string" ? environmentId : undefined;
}

// The exclusive `createdAt > cursor` bound of a window read.
function createdAtGtFromWhere(where: unknown): Date | string | undefined {
  const createdAt = (where as { createdAt?: unknown } | null | undefined)?.createdAt;
  const gt = (createdAt as { gt?: unknown } | null | undefined)?.gt;
  return gt instanceof Date || typeof gt === "string" ? gt : undefined;
}

function toTime(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function isAfter(a: unknown, b: unknown): boolean {
  const ta = toTime(a);
  const tb = toTime(b);
  return ta !== undefined && tb !== undefined && ta > tb;
}

export class TaskRunExecutionSnapshotStore extends DelegatingRunStore {
  readonly #storeSource: RedisSnapshotStore | (() => RedisSnapshotStore);
  readonly #mode: TaskRunExecutionSnapshotStoreMode;
  readonly #resolveDial: NonNullable<TaskRunExecutionSnapshotStoreOptions["resolveDial"]>;
  readonly #residencyResolver: SnapshotResidencyResolver;
  readonly #organizationId?: string;
  readonly #logicalRunStoreRoute: string;
  readonly #newToken: () => string;
  readonly #resolvePending: TaskRunExecutionSnapshotStoreOptions["resolvePending"];
  readonly #resolveCompletedWaitpoints?: CompletedWaitpointResolver;
  readonly #resolveCompletedWaitpointsWithContext: TaskRunExecutionSnapshotStoreOptions["resolveCompletedWaitpointsWithContext"];
  readonly #resolvePrimaryReadClient?: (runId: string) => ReadClient | undefined;
  readonly #redisPrimaryBirthReady: () => boolean;
  readonly #metrics?: SnapshotDecoratorMetrics;
  readonly #hooks?: {
    afterPrepare?: () => void | Promise<void>;
    beforeFinalize?: () => void | Promise<void>;
  };

  constructor(delegate: RunStore, options: TaskRunExecutionSnapshotStoreOptions) {
    super(delegate);
    this.#storeSource = options.store;
    this.#mode = options.mode;
    this.#resolveDial = options.resolveDial ?? (() => options.mode);
    this.#residencyResolver =
      options.residencyResolver ??
      new SnapshotResidencyResolver({
        store: options.store,
      });
    this.#organizationId = options.organizationId;
    this.#logicalRunStoreRoute = options.logicalRunStoreRoute;
    this.#newToken = options.generateTransitionToken ?? (() => generateInternalId());
    this.#resolvePending = options.resolvePending;
    this.#resolveCompletedWaitpoints = options.resolveCompletedWaitpoints;
    this.#resolveCompletedWaitpointsWithContext = options.resolveCompletedWaitpointsWithContext;
    this.#resolvePrimaryReadClient = options.resolvePrimaryReadClient;
    this.#redisPrimaryBirthReady = options.redisPrimaryBirthReady ?? (() => true);
    this.#metrics = options.metrics;
    this.#hooks = options.hooks;
  }

  get #store(): RedisSnapshotStore {
    return typeof this.#storeSource === "function" ? this.#storeSource() : this.#storeSource;
  }

  // A direct write is a one-entry #runInTransaction. A postgres run passes through on the caller's
  // client.
  override async createRun(
    params: CreateRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const runId = params.data.id;
    const organizationId = this.#organizationId ?? params.snapshot.organizationId;
    const residency = await this.#birthResidency(organizationId, params.organizationFlags);
    if (residency === "postgres") {
      // The first enqueue then carries an explicit `postgres` snapshot route, so the TTL fast path
      // expires the run by bulk SQL with no lookup.
      const result = await super.createRun(params, tx);
      params.onBirthResidency?.({ runId, organizationId, residency: "postgres" });
      return result;
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(runId, (store) => store.createRun(params), residency);
  }

  override async createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    const runId = input.run.id;
    const organizationId = this.#organizationId ?? input.organizationId;
    const residency = await this.#writeResidency(
      runId,
      organizationId,
      "transition",
      input.snapshotRoute
    );
    if (residency === "postgres") {
      return super.createExecutionSnapshot(input, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(
      runId,
      (store) => store.createExecutionSnapshot(input),
      residency
    );
  }

  override async lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>> {
    const organizationId = this.#organizationId ?? data.snapshot.organizationId;
    const residency = await this.#writeResidency(
      runId,
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") {
      return super.lockRunToWorker(runId, data, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(runId, (store) => store.lockRunToWorker(runId, data), residency);
  }

  override async createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const runId = params.data.id;
    const organizationId = this.#organizationId ?? params.snapshot.organizationId;
    const residency = await this.#birthResidency(organizationId, params.organizationFlags);
    if (residency === "postgres") {
      return super.createCancelledRun(params, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(runId, (store) => store.createCancelledRun(params), residency);
  }

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
    const organizationId = this.#organizationId ?? data.snapshot.organizationId;
    const residency = await this.#writeResidency(
      runId,
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") {
      return super.completeAttemptSuccess(runId, data, args, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(
      runId,
      (store) => store.completeAttemptSuccess(runId, data, args),
      residency
    );
  }

  override async expireRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      error: TaskRunError;
      completedAt: Date;
      expiredAt: Date;
      snapshot: ExpireSnapshotInput;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const organizationId = this.#organizationId ?? data.snapshot.organizationId;
    const residency = await this.#writeResidency(
      runId,
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") {
      return super.expireRun(runId, data, args, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(runId, (store) => store.expireRun(runId, data, args), residency);
  }

  override async expireParkedRun(
    runId: string,
    data: {
      error: TaskRunError;
      completedAt: Date;
      expiredAt: Date;
      statusReason: string;
      snapshot: ExpireSnapshotInput;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    const organizationId = this.#organizationId ?? data.snapshot.organizationId;
    const residency = await this.#writeResidency(
      runId,
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") {
      return super.expireParkedRun(runId, data, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(runId, (store) => store.expireParkedRun(runId, data), residency);
  }

  override async rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    // A delay update with no snapshot passes straight through.
    if (data.snapshot === undefined) return super.rescheduleRun(runId, data, tx);
    const organizationId = this.#organizationId ?? data.snapshot.organizationId;
    const residency = await this.#writeResidency(
      runId,
      organizationId,
      "transition",
      data.snapshot.snapshotRoute
    );
    if (residency === "postgres") {
      return super.rescheduleRun(runId, data, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.#runInTransaction(runId, (store) => store.rescheduleRun(runId, data), residency);
  }

  // ---- Reads: each dispatches on #resolveReadPlan ----

  override async findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient,
    environmentId?: string,
    serverOrganizationId?: SnapshotReadContext
  ): Promise<LatestExecutionSnapshotRead | null> {
    let postgresRead: LatestExecutionSnapshotRead | null | undefined;
    let context = serverOrganizationId ?? this.#organizationId;
    const resolvedDial =
      typeof context === "string"
        ? { organizationId: context, dial: await this.#resolveDial(context) }
        : undefined;
    const dial = resolvedDial?.dial;
    if (
      context === undefined ||
      (typeof context === "string" && (dial === undefined || dial === "off"))
    ) {
      // Reuse the original TRES read. Its metadata is birth evidence; an off flag is not.
      postgresRead = await super.findLatestExecutionSnapshot(runId, client, environmentId);
      if (postgresRead !== null) context = snapshotRouteFromSnapshot(postgresRead);
    }
    const plan = await this.#resolveReadPlan(
      runId,
      context,
      postgresRead !== undefined,
      resolvedDial
    );
    if (isUnavailablePlan(plan) || plan === "expired") {
      // A positive Postgres row is durable evidence. With no row, never invent a Postgres home for
      // a redis-primary run.
      const postgres =
        postgresRead !== undefined
          ? postgresRead
          : await super.findLatestExecutionSnapshot(runId, client, environmentId);
      if (postgres && snapshotResidencyFromMetadata(postgres.metadata) !== "redis-primary") {
        return postgres;
      }
      if (plan === "expired") throw new SnapshotStateExpiredError(runId);
      throw residencyUnavailableError(runId, plan);
    }
    if (plan === "postgres") {
      return postgresRead !== undefined
        ? postgresRead
        : super.findLatestExecutionSnapshot(runId, client, environmentId);
    }
    await this.#resolvePendingBeforeRead(runId);
    let head: SnapshotRead | null;
    try {
      head = await this.#store.getLatest(runId, environmentId ? { environmentId } : undefined);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "getLatest failed", { cause: error });
    }
    if (head === null) {
      // A redis-primary miss fails closed. A mirrored run reads its complete Postgres copy.
      if (plan === "redisPrimary") {
        throw await this.#redisPrimaryMissingError(runId, "redis-primary head missing");
      }
      return postgresRead !== undefined
        ? postgresRead
        : super.findLatestExecutionSnapshot(runId, client, environmentId);
    }
    if (plan === "redisPrimary") {
      return this.#reproduceSnapshotFromEntry(head, client, environmentId);
    }
    // A pod still at `off` can advance a mirrored run's Postgres history, so an older MemoryDB head
    // does not prove the current head.
    const postgres =
      postgresRead !== undefined
        ? postgresRead
        : await super.findLatestExecutionSnapshot(runId, client, environmentId);
    if (
      postgres !== null &&
      (postgres.id === head.id || isAfter(postgres.createdAt, head.entry.createdAt))
    ) {
      return postgres;
    }
    // MemoryDB can lead the caller's replica. Load that row from the owning primary, never a stale
    // replica result.
    return this.#hydrateOrRepair(head.id, runId, client, environmentId);
  }

  override async findSnapshotCompletedWaitpointIds(
    snapshotId: string,
    client?: ReadClient,
    runId?: string,
    organizationId?: SnapshotReadContext
  ): Promise<string[]> {
    if (runId === undefined) {
      return super.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }
    const plan = await this.#resolveReadPlan(runId, organizationId);
    if (plan === "expired") throw new SnapshotStateExpiredError(runId);
    if (isUnavailablePlan(plan)) throw residencyUnavailableError(runId, plan);
    // Mirrored runs keep completed-waitpoint links in Postgres.
    if (plan === "postgres" || plan === "mirrored") {
      return super.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }
    let waitpoints;
    try {
      waitpoints = await this.#store.getSnapshotWaitpointIds(runId, snapshotId);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "getSnapshotWaitpointIds failed", {
        cause: error,
      });
    }
    // A redis-primary run has no Postgres links, so a missing cycle fails closed.
    if (!waitpoints.present) {
      throw new SnapshotReadUnavailableError(runId, "redis-primary waitpoints missing");
    }
    return waitpoints.distinctIds;
  }

  override async findSnapshotCompletedWaitpointIdsWithPresence(
    snapshotId: string,
    client?: ReadClient,
    runId?: string,
    organizationId?: SnapshotReadContext
  ): Promise<{ present: boolean; ids: string[] }> {
    if (runId === undefined) {
      return super.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }
    const plan = await this.#resolveReadPlan(runId, organizationId);
    if (plan === "expired") throw new SnapshotStateExpiredError(runId);
    if (isUnavailablePlan(plan)) throw residencyUnavailableError(runId, plan);
    // Keep Postgres's atomic snapshot-and-link presence check for mirrored runs too.
    if (plan === "postgres" || plan === "mirrored") {
      return super.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }
    let waitpoints;
    try {
      waitpoints = await this.#store.getSnapshotWaitpointIds(runId, snapshotId);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "getSnapshotWaitpointIds failed", {
        cause: error,
      });
    }
    if (!waitpoints.present) {
      throw new SnapshotReadUnavailableError(runId, "redis-primary waitpoints missing");
    }
    return { present: true, ids: waitpoints.distinctIds };
  }

  // A point read of one snapshot (the window cursor lookup). Only a redis-primary run reads
  // MemoryDB, and a miss fails closed.
  override async findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient,
    organizationId?: SnapshotReadContext
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    const where = (args as { where?: unknown }).where;
    const runId = runIdFromWhere(where);
    if (runId === undefined) return super.findExecutionSnapshot(args, client);
    const context = organizationId ?? this.#organizationId;
    const resolvedDial =
      typeof context === "string"
        ? { organizationId: context, dial: await this.#resolveDial(context) }
        : undefined;
    const dial = resolvedDial?.dial;
    const postgresFirst = typeof context !== "object" && (dial === undefined || dial === "off");
    if (postgresFirst) {
      const postgres = await super.findExecutionSnapshot(args, client);
      if (postgres !== null) {
        return postgres;
      }
    }
    const plan = await this.#resolveReadPlan(runId, organizationId, postgresFirst, resolvedDial);
    if (plan === "expired") throw new SnapshotStateExpiredError(runId);
    if (isUnavailablePlan(plan)) throw residencyUnavailableError(runId, plan);
    if (plan === "postgres" || plan === "mirrored") {
      return super.findExecutionSnapshot(args, client);
    }
    // Narrow contract: this returns the full reproduced row by id and ignores any Prisma `select`.
    // The only production caller (run-engine's getExecutionSnapshotsSince) reads just its
    // `createdAt`.
    const snapshotId = snapshotIdFromWhere(where);
    if (snapshotId === undefined) {
      throw new SnapshotReadUnavailableError(runId, "redis-primary read without a snapshot id");
    }
    const environmentId = environmentIdFromWhere(where);
    await this.#resolvePendingBeforeRead(runId);
    let read: SnapshotRead | null;
    try {
      read = await this.#store.getById(
        runId,
        snapshotId,
        environmentId ? { environmentId } : undefined
      );
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "getById failed", { cause: error });
    }
    if (read === null) {
      throw await this.#redisPrimaryMissingError(runId, "redis-primary snapshot missing");
    }
    return (await this.#reproduceSnapshotFromEntry(
      read,
      client,
      environmentId
    )) as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<T> | null;
  }

  // The window read (createdAt > cursor, checkpoint included, desc, take 50). A redis-primary run
  // rebuilds it from MemoryDB and fails closed. A mirrored run reads Postgres; see #mirroredWindow.
  override async findManyExecutionSnapshots<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    client?: ReadClient,
    organizationId?: SnapshotReadContext
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]> {
    const where = (args as { where?: unknown }).where;
    const runId = runIdFromWhere(where);
    if (runId === undefined) return super.findManyExecutionSnapshots(args, client);
    const plan = await this.#resolveReadPlan(runId, organizationId);
    if (plan === "expired") throw new SnapshotStateExpiredError(runId);
    if (isUnavailablePlan(plan)) throw residencyUnavailableError(runId, plan);
    if (plan === "postgres") return super.findManyExecutionSnapshots(args, client);
    const environmentId = environmentIdFromWhere(where);
    const cursor = createdAtGtFromWhere(where);
    const take = (args as { take?: unknown }).take;
    const limit = typeof take === "number" ? take : undefined;
    if (plan === "redisPrimary") {
      return (await this.#reproduceWindow(
        runId,
        cursor,
        environmentId,
        limit,
        client
      )) as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<T>[];
    }
    return this.#mirroredWindow(args, runId, environmentId, cursor, client);
  }

  // Every read gets its plan here. A redis-primary run reads MemoryDB at any dial. A mirrored run
  // reads the MemoryDB head only when its org's live dial is redis-read or redis-only. A carried
  // snapshot route skips the residency lookup. Nothing is cached per run.
  async #resolveReadPlan(
    runId: string,
    organizationId?: SnapshotReadContext,
    postgresChecked = false,
    resolvedDial?: ResolvedSnapshotDial
  ): Promise<SnapshotReadPlan> {
    const plan = await this.#computeReadPlan(runId, organizationId, postgresChecked, resolvedDial);
    if (plan === "postgres") this.#metrics?.recordReadSource("postgres");
    else if (plan === "redisPrimary" || plan === "mirrored")
      this.#metrics?.recordReadSource("redis");
    return plan;
  }

  async #computeReadPlan(
    runId: string,
    serverOrganizationId?: SnapshotReadContext,
    postgresChecked = false,
    resolvedDial?: ResolvedSnapshotDial
  ): Promise<SnapshotReadPlan> {
    const context = serverOrganizationId ?? this.#organizationId;
    if (typeof context === "object") {
      if (context.residency === "postgres") return "postgres";
      if (context.residency === "redis-primary") return "redisPrimary";
      const dial =
        resolvedDial?.organizationId === context.organizationId
          ? resolvedDial.dial
          : await this.#resolveDial(context.organizationId);
      return dial === undefined || dial === "off" || dial === "dual-write"
        ? "postgres"
        : "mirrored";
    }
    const knownOrganization = context;
    if (knownOrganization !== undefined && resolvedDial?.organizationId !== knownOrganization) {
      resolvedDial = {
        organizationId: knownOrganization,
        dial: await this.#resolveDial(knownOrganization),
      };
    }
    const dial = resolvedDial?.dial;
    if (!postgresChecked && (dial === undefined || dial === "off")) {
      const postgres = await this.delegate.findLatestExecutionSnapshot(
        runId,
        this.#resolvePrimaryReadClient?.(runId)
      );
      if (postgres)
        return this.#computeReadPlan(
          runId,
          snapshotRouteFromSnapshot(postgres),
          true,
          resolvedDial
        );
    }
    let res = await this.#residencyResolver.resolve(runId);
    if (res.kind === "pendingBirth") {
      // Settle the pending birth, then resolve once more.
      if (this.#resolvePending) await this.#resolvePending(runId);
      res = await this.#residencyResolver.resolve(runId);
    }
    switch (res.kind) {
      case "committed": {
        if (res.residency === "redis-primary") return "redisPrimary";
        // Prefer the caller's org, else read it durably. Nothing is cached per pod.
        const organizationId =
          knownOrganization ??
          res.organizationId ??
          (await this.#store.readCommittedOrganizationId(runId));
        const dial =
          organizationId === undefined
            ? undefined
            : resolvedDial?.organizationId === organizationId
              ? resolvedDial.dial
              : await this.#resolveDial(organizationId);
        if (dial === undefined || dial === "off" || dial === "dual-write") {
          return "postgres";
        }
        return "mirrored";
      }
      case "absent":
        return "postgres";
      // Redis-primary state expired after the run finished: fail closed for good.
      case "expired":
        return "expired";
      // An unresolved pending birth or an error fails closed, retriably.
      case "pendingBirth":
      case "error":
        return `unavailable:${res.kind}`;
    }
  }

  // A carried snapshot route skips the residency resolver, so a redis-primary miss is classified
  // here. Expired state is permanent. Every other outcome is the retriable miss.
  async #redisPrimaryMissingError(
    runId: string,
    reason: string
  ): Promise<SnapshotReadUnavailableError> {
    let kind: string;
    try {
      kind = (await this.#residencyResolver.resolve(runId)).kind;
    } catch {
      kind = "error";
    }
    return kind === "expired"
      ? new SnapshotStateExpiredError(runId)
      : new SnapshotReadUnavailableError(runId, reason);
  }

  // Settles a pending unit before a read trusts the MemoryDB head. A quarantine, a MemoryDB error,
  // or a unit still pending afterwards fails closed (retriable), never serving the head from before
  // the unit.
  async #resolvePendingBeforeRead(runId: string): Promise<void> {
    let pending: { prepared: boolean; quarantined: boolean };
    try {
      pending = await this.#store.readPendingState(runId);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "readPendingState failed", { cause: error });
    }
    if (pending.quarantined) {
      throw new SnapshotReadUnavailableError(runId, "run is quarantined");
    }
    if (!pending.prepared) return;
    if (!this.#resolvePending) {
      throw new SnapshotReadUnavailableError(runId, "pending unit and no recovery resolver");
    }
    await this.#resolvePending(runId);
    let after: { prepared: boolean; quarantined: boolean };
    try {
      after = await this.#store.readPendingState(runId);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "readPendingState failed", { cause: error });
    }
    if (after.quarantined) {
      throw new SnapshotReadUnavailableError(runId, "run is quarantined");
    }
    if (after.prepared) {
      throw new SnapshotReadUnavailableError(runId, "pending unit unresolved");
    }
  }

  #hydrateSnapshotById(
    snapshotId: string,
    client?: ReadClient,
    environmentId?: string
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{
    include: { completedWaitpoints: true; checkpoint: true };
  }> | null> {
    return this.delegate.findExecutionSnapshot(
      {
        where: { id: snapshotId, isValid: true, ...(environmentId ? { environmentId } : {}) },
        include: { completedWaitpoints: true, checkpoint: true },
      },
      client
    );
  }

  // A head that MemoryDB names has a committed Postgres row, so a null result is replica lag.
  // Re-read on the owning primary; with no primary, fail retriably. Never returns null.
  async #hydrateOrRepair(
    snapshotId: string,
    runId: string,
    client?: ReadClient,
    environmentId?: string
  ): Promise<LatestExecutionSnapshotRead | null> {
    const hydrated = await this.#hydrateSnapshotById(snapshotId, client, environmentId);
    if (hydrated !== null) return hydrated;
    const primary = this.#resolvePrimaryReadClient?.(runId);
    if (primary === undefined) {
      throw new SnapshotReadUnavailableError(
        runId,
        "mirrored head absent on read client and no primary read client for repair"
      );
    }
    const repaired = await this.#hydrateSnapshotById(snapshotId, primary, environmentId);
    if (repaired === null) {
      throw new SnapshotReadUnavailableError(runId, "mirrored head absent on the owning primary");
    }
    return repaired;
  }

  // Postgres is authoritative, but the caller's replica can lag the head that MemoryDB names.
  // Re-read on the primary only when that head is after the cursor and is not the newest row.
  async #mirroredWindow<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    runId: string,
    environmentId: string | undefined,
    cursor: Date | string | undefined,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]> {
    await this.#resolvePendingBeforeRead(runId);
    const rows = await this.delegate.findManyExecutionSnapshots(args, client);
    let head: SnapshotRead | null;
    try {
      head = await this.#store.getLatest(runId, environmentId ? { environmentId } : undefined);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "getLatest failed", { cause: error });
    }
    if (head === null) return rows;
    if (rows.length > 0 && (rows[0] as { id?: unknown }).id === head.id) return rows;
    // A head at or before the cursor is outside the window, so the window is current.
    const headCreatedAt = (head.entry as { createdAt?: unknown }).createdAt;
    if (cursor === undefined || !isAfter(headCreatedAt, cursor)) return rows;
    const primary = this.#resolvePrimaryReadClient?.(runId);
    if (primary === undefined) {
      throw new SnapshotReadUnavailableError(
        runId,
        "mirrored head absent from window and no primary read client for repair"
      );
    }
    return this.delegate.findManyExecutionSnapshots(args, primary);
  }

  // getSinceCreatedAt returns entries ascending. Emit them newest first, as Postgres does; only the
  // newest row carries the waitpoint order.
  async #reproduceWindow(
    runId: string,
    cursor: Date | string | undefined,
    environmentId: string | undefined,
    limit: number | undefined,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>[]> {
    await this.#resolvePendingBeforeRead(runId);
    if (cursor === undefined) {
      throw new SnapshotReadUnavailableError(runId, "redis-primary window read without a cursor");
    }
    let result: GetSinceResult;
    try {
      result = await this.#store.getSinceCreatedAt(runId, cursor, {
        ...(environmentId ? { environmentId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "getSinceCreatedAt failed", { cause: error });
    }
    // A redis-primary miss fails closed, never an empty window.
    if (result.kind === "miss") {
      throw await this.#redisPrimaryMissingError(runId, "redis-primary window missing");
    }
    const ascending = result.entries;
    // A dangling cycle means the head's order is unknown, not empty. An empty order would drop the
    // runner's completed results and can hang it, so fail closed, retriably.
    const headEntry = ascending[ascending.length - 1];
    if (headEntry?.danglingCycle) {
      throw new SnapshotReadUnavailableError(
        runId,
        "redis-primary window head has a dangling completed-waitpoint cycle (order unknown)"
      );
    }
    const headOrder = result.headWaitpointIds.order;
    const rows: Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>[] = [];
    for (let i = ascending.length - 1; i >= 0; i--) {
      const isHead = i === ascending.length - 1;
      rows.push(await this.#reproduceWindowRow(ascending[i], isHead ? headOrder : [], client));
    }
    return rows;
  }

  // Checkpoints stay in Postgres. The window omits the completed-waitpoint relation to avoid an N×M
  // join, as the Postgres window does.
  async #reproduceWindowRow(
    read: SnapshotRead,
    completedWaitpointOrder: string[],
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    const entry = read.entry as {
      runId: string;
      executionStatus: string;
      description: string;
      runStatus: string;
      environmentId: string;
      environmentType: string;
      projectId: string;
      organizationId: string;
      previousSnapshotId?: string;
      batchId?: string;
      attemptNumber?: number;
      checkpointId?: string;
      workerId?: string;
      runnerId?: string;
      metadata?: unknown;
      error?: string;
      createdAt: string;
    };
    const checkpoint = entry.checkpointId
      ? await this.delegate.findTaskRunCheckpointById(entry.checkpointId, entry.runId, client)
      : null;
    const createdAt = new Date(entry.createdAt);
    return {
      id: read.id,
      engine: "V2",
      executionStatus: entry.executionStatus,
      description: entry.description,
      isValid: read.isValid,
      error: entry.error ?? null,
      previousSnapshotId: entry.previousSnapshotId ?? null,
      runId: entry.runId,
      runStatus: entry.runStatus,
      batchId: entry.batchId ?? null,
      attemptNumber: entry.attemptNumber ?? null,
      environmentId: entry.environmentId,
      environmentType: entry.environmentType,
      projectId: entry.projectId,
      organizationId: entry.organizationId,
      completedWaitpointOrder,
      checkpointId: entry.checkpointId ?? null,
      checkpoint,
      workerId: entry.workerId ?? null,
      runnerId: entry.runnerId ?? null,
      createdAt,
      updatedAt: createdAt,
      lastHeartbeatAt: null,
      metadata: entry.metadata ?? null,
    } as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>;
  }

  // Rebuilds a snapshot read from the MemoryDB entry, with its completed-waitpoint cycle as
  // unenhanced rows and the checkpoint from Postgres. A dangling or incomplete cycle fails closed.
  async #reproduceSnapshotFromEntry(
    head: SnapshotRead,
    client?: ReadClient,
    environmentId?: string
  ): Promise<LatestExecutionSnapshotRead | null> {
    const runId = head.entry.runId as string;
    // The stored entry is untyped JSON. The return is a read DTO, not a Prisma row, so it needs no
    // cast.
    const entry = head.entry as {
      executionStatus: TaskRunExecutionStatus;
      description: string;
      runStatus: TaskRunStatus;
      environmentId: string;
      environmentType: RuntimeEnvironmentType;
      projectId: string;
      organizationId: string;
      previousSnapshotId?: string;
      batchId?: string;
      attemptNumber?: number;
      checkpointId?: string;
      workerId?: string;
      runnerId?: string;
      metadata?: Prisma.JsonValue;
      error?: string;
      createdAt: string;
    };

    let completedWaitpoints: SnapshotReadWaitpoint[] = [];
    let completedWaitpointOrder: string[] = [];
    if (head.cycle) {
      let cw;
      try {
        cw = await this.#store.getSnapshotCompletedWaitpoints(runId, head.id);
      } catch (error) {
        throw new SnapshotReadUnavailableError(runId, "getSnapshotCompletedWaitpoints failed", {
          cause: error,
        });
      }
      if (!cw.present || cw.danglingCycle) {
        throw new SnapshotReadUnavailableError(runId, "redis-primary cycle unreachable");
      }
      if (cw.distinctIds.length > 0 && cw.records.length === 0) {
        throw new SnapshotReadUnavailableError(runId, "redis-primary cycle records missing");
      }
      if (!this.#resolveCompletedWaitpoints && !this.#resolveCompletedWaitpointsWithContext) {
        throw new SnapshotReadUnavailableError(runId, "no completed-waitpoint resolver");
      }
      const args = {
        runId,
        batchId: entry.batchId,
        pointer: head.cycle,
        order: cw.order,
        records: cw.records,
      };
      completedWaitpoints = this.#resolveCompletedWaitpointsWithContext
        ? await this.#resolveCompletedWaitpointsWithContext(args, {
            organizationId: entry.organizationId,
          })
        : await this.#resolveCompletedWaitpoints!(args);
      completedWaitpointOrder = cw.order;
    }

    const checkpoint = entry.checkpointId
      ? await this.delegate.findTaskRunCheckpointById(entry.checkpointId, runId, client)
      : null;

    const createdAt = new Date(entry.createdAt);
    return {
      id: head.id,
      engine: "V2",
      executionStatus: entry.executionStatus,
      description: entry.description,
      isValid: head.isValid,
      error: entry.error ?? null,
      previousSnapshotId: entry.previousSnapshotId ?? null,
      runId,
      runStatus: entry.runStatus,
      batchId: entry.batchId ?? null,
      attemptNumber: entry.attemptNumber ?? null,
      environmentId: entry.environmentId,
      environmentType: entry.environmentType,
      projectId: entry.projectId,
      organizationId: entry.organizationId,
      completedWaitpoints,
      completedWaitpointOrder,
      checkpointId: entry.checkpointId ?? null,
      checkpoint,
      workerId: entry.workerId ?? null,
      runnerId: entry.runnerId ?? null,
      createdAt,
      updatedAt: createdAt,
      lastHeartbeatAt: null,
      metadata: entry.metadata ?? null,
    };
  }

  /**
   * Runs `fn` in the owning transaction through a CapturingTxStore. Every snapshot it writes joins
   * one pending unit: PREPARE before COMMIT, FINALIZE after. A throw before COMMIT aborts the unit.
   * An ambiguous COMMIT is settled from Postgres: committed returns the value, rolled back
   * rethrows, and unsettled leaves the unit for recovery. With no mirrored or redis-primary
   * snapshot, it commits as the plain store would.
   */
  override async runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    // An engine callback can publish to the run queue or ack worker items, and a rollback undoes
    // neither. So a busy prepare never replays it: the earlier unit is settled and the call fails.
    return this.#runInTransaction(runId, fn, undefined, false);
  }

  async #runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>,
    decidedResidency?: "postgres" | "mirrored" | "redis-primary",
    // Only the decorator's own one-call writes are replayed: they have no side effects outside the
    // transaction.
    replayOnBusy = true,
    busyRecoveryAttempted = false
  ): Promise<R> {
    if (runId === undefined) return this.delegate.runInTransaction(runId, fn);
    const boundRunId = runId;
    const collected: CollectedEntry[] = [];
    const transitionToken = this.#newToken();
    let prepared = false;
    let callbackReturned = false;
    let callbackValue: R | undefined;

    let result: R;
    try {
      result = await this.delegate.runInTransaction(boundRunId, async (txStore, tx) => {
        const capturing = new CapturingTxStore(txStore, {
          runId: boundRunId,
          organizationId: this.#organizationId,
          tx,
          collect: (c) => collected.push(c),
          resolveResidency: (organizationId, kind, routeField, organizationFlags) =>
            decidedResidency !== undefined
              ? Promise.resolve(decidedResidency)
              : this.#writeResidency(
                  boundRunId,
                  organizationId,
                  kind,
                  routeField,
                  organizationFlags
                ),
          mint: (s) => this.#withMintedSnapshot(s),
          applyRedisControl: (s, r) => this.#withResidencyControl(s, r),
          buildCycle: (cw, resolveRecords, r) =>
            this.#buildCycle(boundRunId, cw, resolveRecords, r),
        });
        const value = await fn(capturing, tx);
        if (collected.length === 0) return value;

        const residency = collected[0].residency;
        const postgresXid = await this.#currentXid(tx);
        const unit: PreparedPgUnit = {
          protocolVersion: PROTOCOL_VERSION,
          transitionToken,
          postgresXid,
          runId: boundRunId,
          organizationId: collected[0].organizationId,
          residency,
          logicalRunStoreRoute: this.#logicalRunStoreRoute,
          entries: collected.map((c) => c.entry),
          // The first entry's TRES row proves a mirrored transaction committed. A redis-primary
          // unit has no row to probe, so recovery quarantines it on a null xid status.
          ...(residency === "mirrored"
            ? { commitProbeSnapshotId: collected[0].entry.entry.id }
            : {}),
        };
        let prep;
        try {
          prep = await this.#store.prepare(unit);
          if (
            residency === "mirrored" &&
            prep.outcome === "forkGuard" &&
            prep.reason === "head" &&
            (await this.#repairMirroredBase(unit, prep.actualCur, tx))
          ) {
            prep = await this.#store.prepare(unit);
          }
        } catch (error) {
          this.#metrics?.recordWrite("failed");
          throw error;
        }
        if (prep.outcome === "busy" && this.#resolvePending && !busyRecoveryAttempted) {
          // Recovery reads the pooled primary. Here it would hold this connection while it waits
          // for a second one from the same pool, so roll back first and recover after.
          throw new PendingUnitBusyError(boundRunId);
        }
        if (prep.outcome !== "prepared" && prep.outcome !== "idempotent") {
          this.#metrics?.recordWrite(prep.outcome === "forkGuard" ? "forked" : "failed");
          throw new Error(`snapshot prepare rejected: ${prep.outcome}`);
        }
        prepared = true;
        if (this.#hooks?.afterPrepare) {
          await this.#hooks.afterPrepare();
        }
        callbackReturned = true;
        callbackValue = value;
        return value;
      });
    } catch (error) {
      // A throw inside the callback rolled back, so abort the prepared unit.
      if (prepared && !callbackReturned) {
        await this.#store.abortPrepared(boundRunId, transitionToken).catch(() => undefined);
      }
      // A throw after the callback returned is an ambiguous COMMIT. Failing a write that did commit
      // strands the caller, because a retry is rejected as stale. So settle it from Postgres.
      if (
        prepared &&
        callbackReturned &&
        (await this.#ambiguousCommitApplied(boundRunId, collected))
      ) {
        return callbackValue as R;
      }
      if (error instanceof PendingUnitBusyError && this.#resolvePending) {
        // Settle the earlier unit only if its transaction has ended, then retry once. A retry that
        // is still busy, or a callback that must not be replayed, fails with `snapshot prepare
        // rejected: busy`.
        try {
          await this.#resolvePending(boundRunId, { requireSettledTransaction: true });
        } catch (resolveError) {
          this.#metrics?.recordWrite("failed");
          throw resolveError;
        }
        if (!replayOnBusy) {
          this.#metrics?.recordWrite("failed");
          throw new Error("snapshot prepare rejected: busy");
        }
        return this.#runInTransaction(runId, fn, decidedResidency, true, true);
      }
      throw error;
    }

    if (!prepared) return result;

    // Outside the try above, so a throw here leaves the pending unit for recovery and never aborts
    // it.
    if (this.#hooks?.beforeFinalize) {
      await this.#hooks.beforeFinalize();
    }
    let finalizeResult: FinalizeResult;
    try {
      finalizeResult = await this.#store.finalize(boundRunId, transitionToken);
    } catch (error) {
      // A thrown finalize is ambiguous: Postgres committed and the Lua may have run. Prove it
      // applied, else retry the token-fenced finalize once. If that fails too, fail retriably and
      // leave the unit to recovery.
      if (await this.#stagedEntriesAlreadyApplied(boundRunId, collected)) {
        this.#metrics?.recordWrite("written");
        return result;
      }
      let retried: FinalizeResult;
      try {
        retried = await this.#store.finalize(boundRunId, transitionToken);
      } catch (retryError) {
        this.#metrics?.recordWrite("failed");
        throw new SnapshotWriteUnavailableError(boundRunId, FINALIZE_OUTCOME_UNKNOWN, {
          cause: retryError,
          phase: "finalize",
        });
      }
      await this.#settleFinalizeOutcome(boundRunId, collected, retried, { cause: error });
      return result;
    }
    await this.#settleFinalizeOutcome(boundRunId, collected, finalizeResult);
    return result;
  }

  // Resolves only when the staged entries are, or are proven to be, the committed state; else
  // throws. `afterThrown` marks a retry after a thrown finalize and carries its cause.
  async #settleFinalizeOutcome(
    boundRunId: string,
    collected: CollectedEntry[],
    finalizeResult: FinalizeResult,
    afterThrown?: { cause: unknown }
  ): Promise<void> {
    // Only `finalized` succeeds with no read-back. Any other outcome needs proof that the unit
    // applied.
    if (finalizeResult.outcome === "finalized") {
      this.#metrics?.recordWrite("written");
      return;
    }
    // The base is gone or version-incompatible (aged out or evicted), so nothing applied. Never
    // rebuild it. Recovery discards a mirrored unit and quarantines a redis-primary one.
    if (finalizeResult.outcome === "baseMissing") {
      this.#metrics?.recordWrite("failed");
      throw new SnapshotWriteUnavailableError(
        boundRunId,
        "finalize found an expired base; the recovery worker owns the pending unit",
        { phase: "finalize" }
      );
    }
    // stale (a newer token won) or noop (a repeat after a lost reply) succeeds only if read-back
    // proves it.
    if (finalizeResult.outcome === "stale" || finalizeResult.outcome === "noop") {
      if (await this.#stagedEntriesAlreadyApplied(boundRunId, collected)) {
        this.#metrics?.recordWrite("written");
        return;
      }
      this.#metrics?.recordWrite("failed");
      if (afterThrown) {
        // A noop leaves no pending unit, so only the proof failed. A stale stays an unknown
        // outcome.
        throw new SnapshotWriteUnavailableError(
          boundRunId,
          finalizeResult.outcome === "noop"
            ? "finalize applied but the read-back proof failed"
            : FINALIZE_OUTCOME_UNKNOWN,
          { ...afterThrown, phase: "finalize" }
        );
      }
      throw new SnapshotWriteUnavailableError(
        boundRunId,
        `finalize ${finalizeResult.outcome} but the staged entries are not applied`,
        { phase: "finalize" }
      );
    }
    this.#metrics?.recordWrite("failed");
    throw new SnapshotWriteUnavailableError(
      boundRunId,
      // Unreachable by the type; guards against an unknown Lua reply.
      `finalize returned an unexpected outcome: ${(finalizeResult as { outcome: string }).outcome}`,
      { phase: "finalize" }
    );
  }

  async #repairMirroredBase(
    unit: PreparedPgUnit,
    observedCur: string,
    tx: PrismaClientOrTransaction
  ): Promise<boolean> {
    const expectedCur = unit.entries[0]?.expectedCur;
    // Repair runs only when a primary read client is configured.
    if (!expectedCur || this.#resolvePrimaryReadClient?.(unit.runId) === undefined) return false;
    // Read on `tx`: a separate read needs a second connection from the pool this transaction holds.
    // `tx` also sees its own staged rows, so exclude them. A losing concurrent writer is not
    // repaired, because its expected head is no longer the Postgres head.
    const committed = await tx.taskRunExecutionSnapshot.findFirst({
      where: {
        runId: unit.runId,
        isValid: true,
        id: { notIn: boundedIn(unit.entries.map((e) => e.entry.id)) },
      },
      select: { id: true, organizationId: true },
      orderBy: { createdAt: "desc" },
    });
    if (committed?.id !== expectedCur || committed.organizationId !== unit.organizationId)
      return false;
    return this.#store.repairMirroredHead({ runId: unit.runId, id: committed.id }, observedCur);
  }

  // Settles an ambiguous COMMIT's pending unit on a free connection. True only if read-back proves
  // the staged entries applied.
  async #ambiguousCommitApplied(runId: string, collected: CollectedEntry[]): Promise<boolean> {
    if (this.#resolvePending) {
      try {
        await this.#resolvePending(runId, { requireSettledTransaction: true });
      } catch {
        return false;
      }
    }
    if (!(await this.#stagedEntriesAlreadyApplied(runId, collected))) return false;
    this.#metrics?.recordWrite("written");
    return true;
  }

  // The finalize proof: every staged entry, and any cycle it carried, is already stored byte for
  // byte. Not a presence check: the same id with different contents is a conflict and must fail.
  // Reads do not retry, because a read error already means unproven and the run lock is held
  // meanwhile.
  async #stagedEntriesAlreadyApplied(runId: string, collected: CollectedEntry[]): Promise<boolean> {
    for (const c of collected) {
      const id = c.entry.entry.id;
      let read: SnapshotRead | null;
      try {
        read = await this.#store.getById(runId, id, { retry: false });
      } catch {
        return false;
      }
      if (read === null) return false;
      // Finalize stores `JSON.stringify(entry)` (redisSnapshotStore #stageEntry).
      if (read.raw !== JSON.stringify(c.entry.entry)) return false;
      if (c.entry.cycle && !(await this.#stagedCycleReproduces(runId, id, c.entry.cycle))) {
        return false;
      }
    }
    return true;
  }

  // `new` and `carryForward` cycles both carry full refs and records. The stored cycle must be
  // present, not dangling, and match the staged order, distinct ids and records exactly.
  async #stagedCycleReproduces(
    runId: string,
    snapshotId: string,
    cycle: AppendCyclePayload
  ): Promise<boolean> {
    let cw;
    try {
      cw = await this.#store.getSnapshotCompletedWaitpoints(runId, snapshotId, { retry: false });
    } catch {
      return false;
    }
    if (!cw.present || cw.danglingCycle) return false;
    const refs = cycle.completedWaitpoints ?? [];
    if (!arraysEqual(cw.order, deriveOrder(refs))) return false;
    if (!arraysEqual([...cw.distinctIds].sort(), [...deriveDistinctIds(refs)].sort())) return false;
    return JSON.stringify(cw.records) === JSON.stringify(cycle.records ?? []);
  }

  // Forces xid8 assignment. Recovery checks this xid with pg_xact_status.
  async #currentXid(tx: PrismaClientOrTransaction): Promise<string> {
    const rows = (await tx.$queryRawUnsafe("SELECT pg_current_xact_id()::text AS xid")) as Array<{
      xid: string;
    }>;
    return rows[0].xid;
  }

  #withMintedSnapshot<S extends { id?: string; createdAt?: Date }>(snapshot: S): S {
    return {
      ...snapshot,
      id: snapshot.id ?? generateInternalId(),
      createdAt: snapshot.createdAt ?? new Date(),
    };
  }

  async #birthResidency(
    organizationId: string,
    organizationFlags?: unknown
  ): Promise<"postgres" | "mirrored" | "redis-primary"> {
    const dial = await this.#resolveDial(organizationId, organizationFlags);
    if (dial === undefined || dial === "off") return "postgres";
    // Capped to mirrored when MemoryDB is not ready, so a new run is never stranded there.
    if (dial === "redis-only") return this.#redisPrimaryBirthReady() ? "redis-primary" : "mirrored";
    return "mirrored";
  }

  // A birth follows the org's live dial. A transition follows the run's durable residency, never
  // the dial, so a lowered dial cannot freeze a run's MemoryDB head. A Postgres TRES row with no
  // residency marker skips MemoryDB.
  async #writeResidency(
    runId: string,
    organizationId: string,
    kind: "birth" | "transition",
    routeField?: unknown,
    organizationFlags?: unknown
  ): Promise<"postgres" | "mirrored" | "redis-primary"> {
    if (kind === "birth") return this.#birthResidency(organizationId, organizationFlags);
    // A carried snapshot route with a matching org skips the lookup.
    const wire = parseSnapshotRoute(routeField);
    if (wire && wire.organizationId === organizationId) return wire.residency;
    const previous = await this.delegate.findLatestExecutionSnapshot(
      runId,
      this.#resolvePrimaryReadClient?.(runId)
    );
    if (previous) {
      if (previous.organizationId !== organizationId) {
        throw new SnapshotWriteUnavailableError(runId, "snapshot organization mismatch");
      }
      return snapshotResidencyFromMetadata(previous.metadata);
    }
    let res = await this.#residencyResolver.resolve(runId);
    if (res.kind === "pendingBirth") {
      if (this.#resolvePending) await this.#resolvePending(runId);
      res = await this.#residencyResolver.resolve(runId);
    }
    switch (res.kind) {
      case "committed":
        return res.residency;
      case "absent":
        throw new SnapshotWriteUnavailableError(
          runId,
          "existing snapshot is absent from both stores"
        );
      // Expired state, an unresolved pending birth or a MemoryDB error names no residency: never
      // guess.
      default:
        throw new SnapshotWriteUnavailableError(
          runId,
          `durable residency unresolved (${res.kind})`
        );
    }
  }

  // For callers with no preceding snapshot. Uses the transition lookup, so the dial never decides
  // it.
  override async readSnapshotRoute(
    runId: string,
    organizationId: string
  ): Promise<SnapshotRoute | undefined> {
    const residency = await this.#writeResidency(runId, organizationId, "transition");
    return { runId, organizationId, residency };
  }

  // Settles a pending unit on a free connection before the caller's transaction opens. Inside it,
  // the unit makes prepare busy after the callback may have published. A MemoryDB error throws.
  override async settlePendingUnit(runId: string): Promise<void> {
    if (!this.#resolvePending) return;
    if (!(await this.#store.hasPreparedUnit(runId, { retry: false }))) return;
    await this.#resolvePending(runId, { requireSettledTransaction: true });
    // Not settled yet: fail now, as the busy prepare would.
    if (await this.#store.hasPreparedUnit(runId, { retry: false })) {
      this.#metrics?.recordWrite("failed");
      throw new Error("snapshot prepare rejected: busy");
    }
  }

  // Stamps the residency marker. A redis-primary write skips the TRES row and the join rows.
  #withResidencyControl<S extends { writeSnapshotRow?: boolean }>(
    snapshot: S,
    residency: "mirrored" | "redis-primary"
  ): S {
    const input = snapshot as S & {
      snapshotMetadata?: unknown;
      metadata?: unknown;
      snapshot?: { metadata?: unknown };
    };
    return {
      ...snapshot,
      snapshotMetadata: metadataWithSnapshotResidency(
        input.snapshotMetadata ?? input.snapshot?.metadata ?? input.metadata,
        residency
      ),
      ...(residency === "redis-primary" && { writeSnapshotRow: false }),
    };
  }

  // Redis-primary only: a mirrored run keeps its completed-waitpoint links in Postgres join rows.
  async #buildCycle(
    runId: string,
    completedWaitpoints: { id: string; index?: number }[] | undefined,
    resolveRecords: (() => Promise<CompletedWaitpointRecord[]>) | undefined,
    residency: "mirrored" | "redis-primary"
  ): Promise<AppendCyclePayload | undefined> {
    if (residency !== "redis-primary") return undefined;
    if (!completedWaitpoints || completedWaitpoints.length === 0) return undefined;
    // Fresh completions come with a records resolver from the unblock site: mint a new cycle.
    const records = resolveRecords ? await resolveRecords() : undefined;
    if (records && records.length > 0) {
      return { kind: "new", completedWaitpoints, records };
    }
    // Refs with no resolver carry the head's cycle forward (dequeue lock, checkpoint re-enqueue).
    // Carry its full records, so finalize can re-mint the cycle if the head's cycle is gone. If the
    // head cycle cannot reproduce the refs and every record, throw so the transaction rolls back.
    //
    // These reads run inside the open transaction, so they do not retry: a retrying read can
    // outlive the transaction timeout and leave the write ambiguous.
    let head: SnapshotRead | null;
    try {
      head = await this.#store.getLatest(runId, { retry: false });
    } catch (error) {
      throw new SnapshotWriteUnavailableError(runId, "forward-carry head read failed", {
        cause: error,
      });
    }
    if (!head?.cycle) {
      throw new SnapshotWriteUnavailableError(runId, "forward-carry found no head cycle to carry");
    }
    let headCycle: CompletedWaitpointsRead;
    try {
      headCycle = await this.#store.getSnapshotCompletedWaitpoints(runId, head.id, {
        retry: false,
      });
    } catch (error) {
      throw new SnapshotWriteUnavailableError(runId, "forward-carry cycle read failed", {
        cause: error,
      });
    }
    const order = deriveOrder(completedWaitpoints);
    const distinctIds = deriveDistinctIds(completedWaitpoints);
    const everyIdHasRecord = distinctIds.every((id) => headCycle.records.some((r) => r.id === id));
    if (
      !headCycle.present ||
      headCycle.danglingCycle ||
      !arraysEqual(headCycle.order, order) ||
      !arraysEqual([...headCycle.distinctIds].sort(), [...distinctIds].sort()) ||
      !everyIdHasRecord
    ) {
      throw new SnapshotWriteUnavailableError(
        runId,
        "forward-carry cannot reproduce the complete completed-waitpoint cycle"
      );
    }
    return {
      kind: "carryForward",
      cycleSeq: head.cycle.cycleSeq,
      completedWaitpoints,
      records: headCycle.records,
    };
  }

  // The decorator must own the commit, so it rejects an open interactive transaction. A full
  // PrismaClient (it has `$transaction`) is only a routing hint and is ignored.
  #assertOwnsCommit(tx: PrismaClientOrTransaction | undefined): void {
    if (tx !== undefined && !("$transaction" in tx)) {
      throw new Error(
        `TaskRunExecutionSnapshotStore (mode ${this.#mode}) cannot mirror a write inside a caller-supplied transaction`
      );
    }
  }
}
