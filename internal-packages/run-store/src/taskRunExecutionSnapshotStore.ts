// The snapshot-store decorator.
//
// It runs a run's birth and transitions through the durable prepare protocol: open the owning
// Postgres transaction, obtain its xid8, run the writes, PREPARE the ordered unit in MemoryDB hidden
// from reads BEFORE the transaction commits, let the transaction COMMIT, then FINALIZE the unit so its
// entries become visible together. A MIRRORED run (dual-write/redis-read) writes the real TaskRun +
// TRES rows; a REDIS-PRIMARY run (redis-only) writes the TaskRun but NO TRES row, carrying the
// snapshot and its completed-waitpoint cycle in MemoryDB alone.
//
// Reads dispatch on each run's DURABLE residency (resolved from the MemoryDB birth key), NOT the
// constructed dial: a redis-primary run always reads from MemoryDB (fail-closed, no Postgres fallback)
// even at a lowered dial, which makes backward-dialing lossless; a mirrored/postgres run uses the dial
// only for read preference (dual-write reads Postgres, redis-read reads MemoryDB head + Postgres
// payload). Under halt, new redis-primary writes are rejected and mirrored reads prefer Postgres.

import type {
  Prisma,
  PrismaClientOrTransaction,
  RuntimeEnvironmentType,
  TaskRun,
  TaskRunExecutionStatus,
  TaskRunStatus,
} from "@trigger.dev/database";
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
import type {
  AppendCyclePayload,
  CompletedWaitpointRecord,
  CompletedWaitpointResolver,
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
import { parseSnapshotRoute, type SnapshotRoute } from "./snapshotResidency.js";

const PROTOCOL_VERSION = 1;

/**
 * The read/write dial positions this decorator implements. `dual-write` mirrors writes but reads
 * Postgres; `redis-read` additionally serves a mirrored run's head/waitpoint reads pending-safe from
 * MemoryDB; `redis-only` writes redis-primary (no TRES row, the cycle in MemoryDB) and reads
 * pending-safe from MemoryDB with NO Postgres fallback.
 */
export type TaskRunExecutionSnapshotStoreMode = "dual-write" | "redis-read" | "redis-only";

/**
 * A per-organization dial position. `off` (and, distinctly, "the org is absent from the enrolled
 * cohort") means the org never joined the mirror: its writes pass straight through to Postgres with
 * NO prepare protocol and NO MemoryDB read, so the lowest position stays genuinely inert. The three
 * non-off positions map to the store modes above.
 */
export type SnapshotStoreDial = "off" | TaskRunExecutionSnapshotStoreMode;

/**
 * A read that could not be served authoritatively from MemoryDB right now: a pending unit that is
 * still in progress, or a MemoryDB availability error. It is RETRIABLE — the caller retries rather
 * than falling back to a possibly-stale Postgres head. Never thrown for a genuine MemoryDB miss (that
 * recovers from Postgres for a mirrored run).
 */
export class SnapshotReadUnavailableError extends Error {
  readonly retriable = true;
  readonly runId: string;
  readonly reason: string;
  readonly cause?: unknown;
  constructor(runId: string, reason: string, options?: { cause?: unknown }) {
    super(`snapshot read unavailable for ${runId}: ${reason}`);
    this.name = "SnapshotReadUnavailableError";
    this.runId = runId;
    this.reason = reason;
    this.cause = options?.cause;
  }
}

/**
 * A redis-primary write (birth or transition) refused because the store is halted. A redis-primary
 * transition has no Postgres home (no TRES row), so under halt it is REJECTED rather than mis-written
 * or silently dropped: the caller retries once the operator dials back. Never changes residency.
 */
export class SnapshotWriteHaltedError extends Error {
  readonly retriable = true;
  readonly runId: string;
  constructor(runId: string) {
    super(`snapshot write halted for ${runId}: new redis-primary writes are rejected while halted`);
    this.name = "SnapshotWriteHaltedError";
    this.runId = runId;
  }
}

/**
 * A transition write whose owning run has an unresolvable durable residency right now (a MemoryDB
 * availability error, or state that aged out): fail closed and RETRIABLE rather than guess a residency
 * and risk diverging a mirrored run's head from its Postgres copy.
 */
export class SnapshotWriteUnavailableError extends Error {
  readonly retriable = true;
  readonly runId: string;
  constructor(runId: string, reason: string) {
    super(`snapshot write unavailable for ${runId}: ${reason}`);
    this.name = "SnapshotWriteUnavailableError";
    this.runId = runId;
  }
}

/**
 * The narrow, bounded-cardinality metric sink the decorator feeds from its own dispatch. Distinct from
 * the store-level SnapshotStoreMetrics: this records transaction-sized write outcomes and where reads
 * were served. Every label is a fixed enum; it never carries an organization id. Absent => no-op (the
 * decorator adds no hot-path work when metrics are not constructed).
 */
export type SnapshotDecoratorMetrics = {
  // One per transaction-sized prepared unit: "written" finalized, "forked" a prepare fork-guard
  // rejection, "failed" a thrown/rejected prepare or finalize.
  recordWrite(outcome: "written" | "forked" | "failed"): void;
  // Where an authoritative read was dispatched from (MemoryDB head vs Postgres).
  recordReadSource(source: "redis" | "postgres"): void;
};

export type TaskRunExecutionSnapshotStoreOptions = {
  store: RedisSnapshotStore;
  /** Bounded decorator metric sink; omitted (unconfigured / latch off) => no instruments, no hot-path work. */
  metrics?: SnapshotDecoratorMetrics;
  /**
   * The default dial, used for births and as the mirrored-read preference when `resolveDial` is not
   * injected. In production a shared store serves many orgs, so `resolveDial` overrides this per run.
   */
  mode: TaskRunExecutionSnapshotStoreMode;
  /**
   * Resolves an organization's CURRENT dial from the in-memory enrolled-cohort map. `undefined` means
   * the org is not enrolled (never dialed past off): its writes stay inert (straight passthrough, no
   * MemoryDB read). Defaults to the constructed `mode` for every org (test/back-compat).
   *
   * CONTRACT (load-bearing): `undefined` MUST be MONOTONE. Once this returns a defined dial for an org
   * it must NEVER return `undefined` for that org again. A transition treats `undefined` as inert and
   * skips the durable-residency read (that is the whole inertness win), so if a once-enrolled org ever
   * presented as `undefined` while it had a live redis-primary run, that run's transition would divert
   * to Postgres while reads still served the now-frozen MemoryDB head: silent divergence. Residency is
   * durable in MemoryDB, so enrollment must be equally durable. Back this with the ONE-WAY enrollment
   * latch (a never-cleared flag / permanent cohort-map presence), NEVER an evictable cache. A drained
   * org returns `off` (still defined: its resident runs keep draining), never `undefined`.
   */
  resolveDial?: (organizationId: string) => SnapshotStoreDial | undefined;
  /**
   * Resolves a run's DURABLE residency from the MemoryDB birth key so reads dispatch on the run, not
   * the dial. Injected (and shared, so its LRU cache is warm) in production; when omitted the store
   * builds a private one over its own MemoryDB connection.
   */
  residencyResolver?: SnapshotResidencyResolver;
  /**
   * The polled halt flag. When true, new redis-primary writes are rejected and mirrored reads prefer
   * the complete Postgres copy. Never gates the recovery worker (a separate role). Defaults to never
   * halted.
   */
  halted?: () => boolean;
  /** The unit's organization, when the caller carries a trusted one; else taken from the snapshot. */
  organizationId?: string;
  /** The stable LOGICAL run-store route the recovery worker uses to reach the owning primary. */
  logicalRunStoreRoute: string;
  /** Mint a fresh transition token per unit. Overridable for deterministic tests. */
  generateTransitionToken?: () => string;
  /**
   * Drives recovery resolution for a run with a PENDING prepared unit before a `redis-read` read
   * trusts the MemoryDB head: it resolves the owning Postgres transaction (via `pg_xact_status`) and
   * finalizes/aborts, leaving the unit pending only when the transaction is still in progress.
   */
  resolvePending?: (runId: string) => Promise<void>;
  /**
   * Expands a redis-primary snapshot's completed-waitpoint cycle records into `CompletedWaitpoint[]`.
   * The waitpoint lane owns the implementation (it lives in run-engine because a `deriveFromRun`
   * record needs a Postgres read); the decorator only injects and calls it. Required for a redis-only
   * read whose head carries completed waitpoints.
   */
  resolveCompletedWaitpoints?: CompletedWaitpointResolver;
  /**
   * The primary-read repair seam. When MemoryDB names the authoritative mirrored head id but hydrating
   * THAT exact row from the caller's read client returns null (a lagging read replica), the row is
   * re-read from the client this resolves — a WRITER/primary, which the routing store maps to the
   * OWNING store's primary (read-your-writes). `undefined` (or the option omitted) means no primary is
   * reachable from the decorator, so such a hydrate miss fails RETRIABLE rather than returning null.
   */
  resolvePrimaryReadClient?: (runId: string) => ReadClient | undefined;
  /**
   * Redis-only birth readiness. Consulted ONLY at a birth: when a `redis-only` dial would mint a new
   * redis-primary run but the MemoryDB is not ready (evicting policy, unreadable, version mismatch),
   * the birth is capped to `mirrored` so it still writes Postgres and never becomes a stranded
   * redis-primary resident. Enrollment is untouched (the org stays on its dial) and an already-resident
   * run is never affected — a transition follows durable residency, not this. Default: always ready.
   */
  redisPrimaryBirthReady?: () => boolean;
  /**
   * Failure-injection seams. `afterPrepare` is invoked inside the owning transaction AFTER the
   * MemoryDB prepare completes and BEFORE the transaction commits; a throw there rolls the
   * transaction back, exercising the abort-on-error path. `beforeFinalize` is invoked AFTER the
   * commit succeeds and BEFORE the MemoryDB finalize; a throw there simulates a process crash after
   * commit / before finalize, leaving the unit PREPARED + PENDING with Postgres committed — the
   * interrupted state the recovery worker exists to resolve.
   */
  hooks?: {
    afterPrepare?: () => void | Promise<void>;
    beforeFinalize?: () => void | Promise<void>;
  };
};

/** One collected snapshot write inside an owning transaction: its staged entry plus the run's org and residency. */
type CollectedEntry = {
  entry: PreparedEntry;
  organizationId: string;
  residency: "mirrored" | "redis-primary";
};

type CaptureDeps = {
  runId: string;
  organizationId?: string;
  // The owning interactive transaction. Every Postgres write the capturing store issues MUST run on it
  // (not the delegate's auto-commit client), or a later throw could not roll the write back.
  tx: PrismaClientOrTransaction;
  collect: (c: CollectedEntry) => void;
  resolveResidency: (
    organizationId: string,
    kind: "birth" | "transition",
    routeField?: unknown
  ) => Promise<"postgres" | "mirrored" | "redis-primary">;
  halted: () => boolean;
  assertHalted: (residency: "mirrored" | "redis-primary", runId: string) => void;
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

/**
 * The transaction-bound decorated store the owning transaction runs through (T6.1). It writes each
 * snapshot to Postgres via the tx-bound delegate and COLLECTS the ordered staged entry; the surrounding
 * runInTransaction then prepares them as ONE transaction-sized unit. A postgres-resident (inert) run
 * writes straight through and collects nothing. A run's residency is immutable, so it is resolved once
 * on the first snapshot write of the transaction and reused (one unit is exactly one run).
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
    routeField?: unknown
  ): Promise<"postgres" | "mirrored" | "redis-primary"> {
    if (this.#residency !== undefined) return this.#residency;
    this.#residency = await this.deps.resolveResidency(organizationId, kind, routeField);
    return this.#residency;
  }

  // A unit is exactly ONE run. Validate the operation's ACTUAL run id against the transaction's bound
  // run id BEFORE any Postgres mutation, so a multi-run transaction (or a mis-routed write) is rejected
  // rather than mixed into another run's unit. The actual id, never the bound id, identifies the entry.
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
    const residency = await this.#residencyFor(organizationId, "birth");
    if (residency === "postgres") return super.createRun(params, this.deps.tx);
    this.deps.assertHalted(residency, runId);
    const snapshot = this.deps.applyRedisControl(this.deps.mint(params.snapshot), residency);
    const result = await super.createRun({ ...params, snapshot }, this.deps.tx);
    // Surface the decided route so the trigger path stamps the INITIAL enqueue without a durable lookup.
    params.onBirthResidency?.({ runId, organizationId, residency });
    const entry = entryFromCreateRun(
      { id: snapshot.id!, runId, createdAt: snapshot.createdAt! },
      snapshot
    );
    this.deps.collect({
      // A birth asserts the committed head is UNSET (`""`): a second birth on an existing run forks.
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
    this.deps.assertHalted(residency, runId);
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
      // The fork guard: this transition asserts the head is its declared previous snapshot. In a
      // multi-entry unit the batch validator chains each entry's expectedCur against its predecessor.
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
    this.deps.assertHalted(residency, runId);
    const createdAt = data.snapshot.createdAt ?? new Date();
    const snapshot = this.deps.applyRedisControl({ ...data.snapshot, createdAt }, residency);
    const result = await super.lockRunToWorker(runId, { ...data, snapshot }, this.deps.tx);
    const entry = entryFromLock({ id: snapshot.id, runId, createdAt }, snapshot);
    this.deps.collect({
      entry: {
        entry,
        kind: "transition",
        isTerminal: isTerminalEntry(entry),
        ...(snapshot.previousSnapshotId !== undefined && {
          expectedCur: snapshot.previousSnapshotId,
        }),
      },
      organizationId,
      residency,
    });
    return result;
  }

  // A cancellation CREATES the run row with its single terminal snapshot, so it is the run's BIRTH
  // (expectedCur "": a second birth on an existing run forks), mirrored exactly like createRun.
  override async createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const runId = params.data.id;
    const organizationId = this.deps.organizationId ?? params.snapshot.organizationId;
    this.#assertBoundRun(runId);
    const residency = await this.#residencyFor(organizationId, "birth");
    if (residency === "postgres") return super.createCancelledRun(params, this.deps.tx);
    this.deps.assertHalted(residency, runId);
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
    this.deps.assertHalted(residency, runId);
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
    this.deps.assertHalted(residency, runId);
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

  // Conditional: the delegate reports `{ count: 0 }` on the P2025 no-op (the run was not
  // PENDING_VERSION), in which case NO snapshot row was written — collect nothing (no phantom entry).
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
    this.deps.assertHalted(residency, runId);
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

  // Conditional: rescheduleRun writes a snapshot ONLY when `data.snapshot` is present; a bare delay
  // update passes straight through and collects nothing (no phantom entry).
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
    this.deps.assertHalted(residency, runId);
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

// A read's owning run id, from `where.runId`. A snapshot-id-only lookup (no runId) is not determinable
// and passes through to Postgres, matching the existing waitpoint-id guard.
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

// The exclusive `createdAt > cursor` bound the read-since window is addressed by.
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
  readonly #store: RedisSnapshotStore;
  readonly #mode: TaskRunExecutionSnapshotStoreMode;
  readonly #resolveDial: (organizationId: string) => SnapshotStoreDial | undefined;
  readonly #residencyResolver: SnapshotResidencyResolver;
  readonly #halted: () => boolean;
  readonly #organizationId?: string;
  readonly #logicalRunStoreRoute: string;
  readonly #newToken: () => string;
  readonly #resolvePending?: (runId: string) => Promise<void>;
  readonly #resolveCompletedWaitpoints?: CompletedWaitpointResolver;
  readonly #resolvePrimaryReadClient?: (runId: string) => ReadClient | undefined;
  readonly #redisPrimaryBirthReady: () => boolean;
  readonly #metrics?: SnapshotDecoratorMetrics;
  readonly #hooks?: {
    afterPrepare?: () => void | Promise<void>;
    beforeFinalize?: () => void | Promise<void>;
  };

  constructor(delegate: RunStore, options: TaskRunExecutionSnapshotStoreOptions) {
    super(delegate);
    this.#store = options.store;
    this.#mode = options.mode;
    this.#resolveDial = options.resolveDial ?? (() => options.mode);
    this.#residencyResolver =
      options.residencyResolver ??
      new SnapshotResidencyResolver({
        store: options.store,
        // A private resolver never caches an absent result (it has no TaskRun probe); the injected
        // production resolver does. Correctness of dispatch does not depend on caching.
        taskRunExists: () => Promise.resolve(false),
        // Carry the run org on the committed result so a read dispatches on the org's live dial.
        resolveOrganizationId: (runId) => options.store.readCommittedOrganizationId(runId),
      });
    this.#halted = options.halted ?? (() => false);
    this.#organizationId = options.organizationId;
    this.#logicalRunStoreRoute = options.logicalRunStoreRoute;
    this.#newToken = options.generateTransitionToken ?? (() => generateInternalId());
    this.#resolvePending = options.resolvePending;
    this.#resolveCompletedWaitpoints = options.resolveCompletedWaitpoints;
    this.#resolvePrimaryReadClient = options.resolvePrimaryReadClient;
    this.#redisPrimaryBirthReady = options.redisPrimaryBirthReady ?? (() => true);
    this.#metrics = options.metrics;
    this.#hooks = options.hooks;
  }

  // A direct snapshot write is a ONE-entry owning transaction: an inert (postgres) run passes straight
  // through honoring the caller's client; a mirrored/redis-primary run routes through the same
  // runInTransaction orchestration the engine's multi-write transactions use, so the write path is one.
  override async createRun(
    params: CreateRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const runId = params.data.id;
    const organizationId = this.#organizationId ?? params.snapshot.organizationId;
    if ((await this.#writeResidency(runId, organizationId, "birth")) === "postgres") {
      return super.createRun(params, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.createRun(params));
  }

  override async createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    const runId = input.run.id;
    const organizationId = this.#organizationId ?? input.organizationId;
    if (
      (await this.#writeResidency(runId, organizationId, "transition", input.snapshotRoute)) ===
      "postgres"
    ) {
      return super.createExecutionSnapshot(input, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.createExecutionSnapshot(input));
  }

  override async lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>> {
    const organizationId = this.#organizationId ?? data.snapshot.organizationId;
    if (
      (await this.#writeResidency(
        runId,
        organizationId,
        "transition",
        data.snapshot.snapshotRoute
      )) === "postgres"
    ) {
      return super.lockRunToWorker(runId, data, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.lockRunToWorker(runId, data));
  }

  override async createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const runId = params.data.id;
    const organizationId = this.#organizationId ?? params.snapshot.organizationId;
    if ((await this.#writeResidency(runId, organizationId, "birth")) === "postgres") {
      return super.createCancelledRun(params, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.createCancelledRun(params));
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
    if (
      (await this.#writeResidency(
        runId,
        organizationId,
        "transition",
        data.snapshot.snapshotRoute
      )) === "postgres"
    ) {
      return super.completeAttemptSuccess(runId, data, args, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.completeAttemptSuccess(runId, data, args));
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
    if (
      (await this.#writeResidency(
        runId,
        organizationId,
        "transition",
        data.snapshot.snapshotRoute
      )) === "postgres"
    ) {
      return super.expireRun(runId, data, args, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.expireRun(runId, data, args));
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
    if (
      (await this.#writeResidency(
        runId,
        organizationId,
        "transition",
        data.snapshot.snapshotRoute
      )) === "postgres"
    ) {
      return super.expireParkedRun(runId, data, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.expireParkedRun(runId, data));
  }

  override async rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    // A bare delay update writes no snapshot: pass straight through, no prepare protocol.
    if (data.snapshot === undefined) return super.rescheduleRun(runId, data, tx);
    const organizationId = this.#organizationId ?? data.snapshot.organizationId;
    if (
      (await this.#writeResidency(
        runId,
        organizationId,
        "transition",
        data.snapshot.snapshotRoute
      )) === "postgres"
    ) {
      return super.rescheduleRun(runId, data, tx);
    }
    this.#assertOwnsCommit(tx);
    return this.runInTransaction(runId, (store) => store.rescheduleRun(runId, data));
  }

  // ---- Reads ----
  //
  // Every read resolves the run's durable residency, then dispatches: a redis-primary run reproduces
  // its payload from MemoryDB (fail-closed, no Postgres fallback) at ANY dial; a mirrored run reads
  // its MemoryDB head + Postgres payload at redis-read/redis-only, or straight Postgres at dual-write
  // or under halt; a postgres-resident run passes through to Postgres.

  override async findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient,
    environmentId?: string
  ): Promise<LatestExecutionSnapshotRead | null> {
    const plan = await this.#resolveReadPlan(runId);
    if (plan === "unavailable") {
      throw new SnapshotReadUnavailableError(runId, "residency unresolved or state expired");
    }
    if (plan === "postgres") {
      return super.findLatestExecutionSnapshot(runId, client, environmentId);
    }
    await this.#resolvePendingBeforeRead(runId);
    let head: SnapshotRead | null;
    try {
      head = await this.#store.getLatest(runId, environmentId ? { environmentId } : undefined);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "getLatest failed", { cause: error });
    }
    if (head === null) {
      // Redis-primary holds nothing in Postgres, so a MemoryDB miss is fail-closed, never an empty PG
      // success. A mirrored run recovers from its complete Postgres copy. A MemoryDB ERROR is never a
      // miss (it threw above).
      if (plan === "redisPrimary") {
        throw new SnapshotReadUnavailableError(runId, "redis-primary head missing");
      }
      return super.findLatestExecutionSnapshot(runId, client, environmentId);
    }
    if (plan === "redisPrimary") {
      // No Postgres row exists: reproduce the full payload from the MemoryDB entry alone.
      return this.#reproduceSnapshotFromEntry(head, client, environmentId);
    }
    // MemoryDB is authoritative for WHICH snapshot is the committed head (pending-safe above); the full
    // payload with relations is hydrated from the mirrored Postgres row by that id, repaired from the
    // owning primary if the caller's read replica has not caught up (never null for a named head).
    return this.#hydrateOrRepair(head.id, runId, client, environmentId);
  }

  override async findSnapshotCompletedWaitpointIds(
    snapshotId: string,
    client?: ReadClient,
    runId?: string
  ): Promise<string[]> {
    if (runId === undefined) {
      return super.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }
    const plan = await this.#resolveReadPlan(runId);
    if (plan === "unavailable") {
      throw new SnapshotReadUnavailableError(runId, "residency unresolved or state expired");
    }
    if (plan === "postgres") {
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
    // Not visible in MemoryDB (a pre-cutover id, expired, or a dangling cycle): a mirrored run reads
    // its Postgres join rows, but redis-primary holds none, so it fails closed instead.
    if (!waitpoints.present) {
      if (plan === "redisPrimary") {
        throw new SnapshotReadUnavailableError(runId, "redis-primary waitpoints missing");
      }
      return super.findSnapshotCompletedWaitpointIds(snapshotId, client, runId);
    }
    return waitpoints.distinctIds;
  }

  override async findSnapshotCompletedWaitpointIdsWithPresence(
    snapshotId: string,
    client?: ReadClient,
    runId?: string
  ): Promise<{ present: boolean; ids: string[] }> {
    if (runId === undefined) {
      return super.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }
    const plan = await this.#resolveReadPlan(runId);
    if (plan === "unavailable") {
      throw new SnapshotReadUnavailableError(runId, "residency unresolved or state expired");
    }
    if (plan === "postgres") {
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
      if (plan === "redisPrimary") {
        throw new SnapshotReadUnavailableError(runId, "redis-primary waitpoints missing");
      }
      return super.findSnapshotCompletedWaitpointIdsWithPresence(snapshotId, client, runId);
    }
    return { present: true, ids: waitpoints.distinctIds };
  }

  // A point read of a specific snapshot within a run (the read-since cursor lookup). A postgres or
  // mirrored run reads the complete Postgres row by that id; only a redis-primary run (no TRES row)
  // reproduces it from a MemoryDB point-read, failing closed on a miss (never an empty Postgres hit).
  override async findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    const where = (args as { where?: unknown }).where;
    const runId = runIdFromWhere(where);
    if (runId === undefined) return super.findExecutionSnapshot(args, client);
    const plan = await this.#resolveReadPlan(runId);
    if (plan === "unavailable") {
      throw new SnapshotReadUnavailableError(runId, "residency unresolved or state expired");
    }
    if (plan === "postgres" || plan === "mirrored") {
      return super.findExecutionSnapshot(args, client);
    }
    // Narrow contract: for a redis-primary run this branch serves a by-id point read by reproducing the
    // full snapshot row from the MemoryDB entry; it does NOT reproduce an arbitrary Prisma `select` /
    // `where`. The only production caller (run-engine's getExecutionSnapshotsSince) reads the row's
    // `createdAt` as a since-marker, which the reproduced row always carries.
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
      throw new SnapshotReadUnavailableError(runId, "redis-primary snapshot missing");
    }
    return (await this.#reproduceSnapshotFromEntry(
      read,
      client,
      environmentId
    )) as unknown as Prisma.TaskRunExecutionSnapshotGetPayload<T> | null;
  }

  // The read-since window (createdAt-gt, checkpoint include, desc, take:50). A postgres run passes
  // through; a redis-primary run reproduces the window from MemoryDB (fail-closed); a mirrored run
  // reads the complete Postgres copy but repairs a replica-lagged newest row from the owning primary.
  override async findManyExecutionSnapshots<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]> {
    const where = (args as { where?: unknown }).where;
    const runId = runIdFromWhere(where);
    if (runId === undefined) return super.findManyExecutionSnapshots(args, client);
    const plan = await this.#resolveReadPlan(runId);
    if (plan === "unavailable") {
      throw new SnapshotReadUnavailableError(runId, "residency unresolved or state expired");
    }
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

  // Chooses a read's source from the run's DURABLE residency and, for a mirrored run, the run ORG's
  // LIVE per-org dial (never the constructed mode). A redis-primary run is always served from MemoryDB
  // (fail-closed); a mirrored run reads the complete Postgres copy when its org dial is off/dual-write
  // or under halt, and the MemoryDB head under redis-read/redis-only; a postgres-resident run passes
  // through. Resolution (with the org) is cached, so this adds no Postgres query on the hot path.
  // Records where the read dispatched (MemoryDB head for redis-primary/mirrored-redis-read, else
  // Postgres); "unavailable" served nothing. All read call sites go through this.
  async #resolveReadPlan(
    runId: string
  ): Promise<"postgres" | "mirrored" | "redisPrimary" | "unavailable"> {
    const plan = await this.#computeReadPlan(runId);
    if (plan === "postgres") this.#metrics?.recordReadSource("postgres");
    else if (plan === "redisPrimary" || plan === "mirrored")
      this.#metrics?.recordReadSource("redis");
    return plan;
  }

  async #computeReadPlan(
    runId: string
  ): Promise<"postgres" | "mirrored" | "redisPrimary" | "unavailable"> {
    let res = await this.#residencyResolver.resolve(runId);
    if (res.kind === "pendingBirth") {
      // A birth is prepared but not finalized: resolve its owning transaction, then re-resolve once.
      if (this.#resolvePending) await this.#resolvePending(runId);
      res = await this.#residencyResolver.resolve(runId);
    }
    switch (res.kind) {
      case "committed": {
        if (res.residency === "redis-primary") return "redisPrimary";
        // A mirrored run has a complete Postgres copy. The org came from the cached committed result;
        // a resolver that did not carry it (no injected org read) is read on demand as a fallback.
        const organizationId =
          res.organizationId ?? (await this.#store.readCommittedOrganizationId(runId));
        const dial = organizationId !== undefined ? this.#resolveDial(organizationId) : undefined;
        if (this.#halted() || dial === undefined || dial === "off" || dial === "dual-write") {
          return "postgres";
        }
        return "mirrored";
      }
      case "absent":
        return "postgres";
      // expired (redis-primary state aged out), an unresolved pendingBirth, and error all fail closed.
      default:
        return "unavailable";
    }
  }

  // Resolves a PENDING prepared unit before a redis-read trusts the MemoryDB head. A still-pending
  // unit after resolution means the owning transaction is in progress: fail closed (retriable) rather
  // than serve the stale pre-pending head. A MemoryDB read error is never a miss: fail closed too.
  async #resolvePendingBeforeRead(runId: string): Promise<void> {
    let pending: boolean;
    try {
      pending = await this.#store.hasPreparedUnit(runId);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "hasPreparedUnit failed", { cause: error });
    }
    if (!pending) return;
    if (!this.#resolvePending) {
      throw new SnapshotReadUnavailableError(runId, "pending unit and no recovery resolver");
    }
    await this.#resolvePending(runId);
    let stillPending: boolean;
    try {
      stillPending = await this.#store.hasPreparedUnit(runId);
    } catch (error) {
      throw new SnapshotReadUnavailableError(runId, "hasPreparedUnit failed", { cause: error });
    }
    if (stillPending) {
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

  // Hydrates a MemoryDB-named mirrored head by id, repairing a replica-lagged miss from the owning
  // primary. A named head has a committed Postgres row, so a null hydrate is replica lag, never a real
  // miss: re-read on the primary; if no primary is reachable, fail RETRIABLE. Never returns null.
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

  // The mirrored read-since window. The complete Postgres copy is authoritative, but the committed head
  // (named by MemoryDB) can lag on the caller's read replica: read Postgres, and only when the head
  // belongs in the window (after the cursor) yet is missing as the newest row, repair from the primary.
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
    // The head is not the window's newest row. Only a head AFTER the cursor belongs in this window; a
    // head at/older than the cursor means the (possibly empty) window is genuinely current.
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

  // Reproduces the read-since window entirely from MemoryDB for a redis-primary run (no TRES rows). The
  // window is cursor-addressed; getSinceCreatedAt returns entries ascending, so they are emitted DESC
  // (newest first) to match the Postgres order, and only the newest carries the waitpoint order.
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
    // Redis-primary holds nothing in Postgres, so a MemoryDB miss is fail-closed, never an empty window.
    if (result.kind === "miss") {
      throw new SnapshotReadUnavailableError(runId, "redis-primary window missing");
    }
    const ascending = result.entries;
    // A dangling cycle means the head's completed-waitpoint order is UNKNOWN (its cycle key aged out),
    // not empty. Emitting an empty order here would silently drop the runner's completed results and can
    // hang it, so fail closed. A redis-primary run has no Postgres copy to fall back to; the caller
    // (recovery / retry) treats this as a transient read failure. A genuine no-cycle head is not dangling
    // and still returns its (empty) order normally below.
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

  // One reproduced window row: the scalar document plus its checkpoint (checkpoints stay in Postgres).
  // The completed-waitpoint relation is deliberately absent (the window excludes it to avoid the N×M
  // explosion); only the scalar completedWaitpointOrder is carried, populated for the newest row.
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

  // Reproduces the snapshot read entirely from the MemoryDB entry: the scalar document, its
  // completed-waitpoint cycle resolved into unenhanced read rows, and the checkpoint hydrated from
  // Postgres by id (checkpoints stay in Postgres). A dangling or insufficient cycle fails closed
  // rather than returning a lossy set; Postgres holds no join rows to fall back to.
  async #reproduceSnapshotFromEntry(
    head: SnapshotRead,
    client?: ReadClient,
    environmentId?: string
  ): Promise<LatestExecutionSnapshotRead | null> {
    const runId = head.entry.runId as string;
    // The one cast that belongs here: the stored entry is untyped JSON, so parsing it names the column
    // types it was written from. The RETURN needs no cast — it is a snapshot-read DTO, not a Prisma row.
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
      if (!this.#resolveCompletedWaitpoints) {
        throw new SnapshotReadUnavailableError(runId, "no completed-waitpoint resolver");
      }
      completedWaitpoints = await this.#resolveCompletedWaitpoints({
        runId,
        batchId: entry.batchId,
        pointer: head.cycle,
        order: cw.order,
        records: cw.records,
      });
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
   * The durable prepare protocol, orchestrated around the OWNING transaction (T6.1). The callback runs
   * through a transaction-bound decorated store that writes each snapshot to Postgres and collects the
   * ordered staged entry. Every snapshot the transaction produces becomes ONE transaction-sized
   * PreparedPgUnit: the MemoryDB prepare happens inside the transaction before commit, the finalize
   * after commit succeeds. A throw before commit aborts the prepared unit; an ambiguous commit (the
   * callback returned but the commit itself threw) leaves the unit PENDING for the recovery worker.
   * A transaction that produces no mirrored snapshot entry (all-postgres, or no snapshot write) commits
   * exactly as the undecorated store would, with no MemoryDB work.
   */
  override async runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    if (runId === undefined) return this.delegate.runInTransaction(runId, fn);
    const boundRunId = runId;
    const collected: CollectedEntry[] = [];
    const transitionToken = this.#newToken();
    let prepared = false;
    let callbackReturned = false;

    let result: R;
    try {
      result = await this.delegate.runInTransaction(boundRunId, async (txStore, tx) => {
        const capturing = new CapturingTxStore(txStore, {
          runId: boundRunId,
          organizationId: this.#organizationId,
          tx,
          collect: (c) => collected.push(c),
          resolveResidency: (organizationId, kind, routeField) =>
            this.#writeResidency(boundRunId, organizationId, kind, routeField),
          halted: this.#halted,
          assertHalted: (residency, id) => {
            // A redis-primary write has no Postgres home; under halt it is rejected before any work so
            // nothing is half-written and residency is untouched. Mirrored writes (a complete Postgres
            // copy) proceed. Recovery is a separate role, never gated here.
            if (this.#halted() && residency === "redis-primary") {
              throw new SnapshotWriteHaltedError(id);
            }
          },
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
          // A redis-primary unit has no TRES row to point at, so no commit probe: a null xid status is
          // the accepted fail-closed boundary the recovery worker quarantines, never guesses. A mirrored
          // unit points at the FIRST entry of the transaction, whose presence proves the whole tx committed.
          ...(residency === "mirrored"
            ? { commitProbeSnapshotId: collected[0].entry.entry.id }
            : {}),
        };
        let prep;
        try {
          prep = await this.#store.prepare(unit);
        } catch (error) {
          this.#metrics?.recordWrite("failed");
          throw error;
        }
        if (prep.outcome !== "prepared" && prep.outcome !== "idempotent") {
          // A fork guard is a distinct, expected write outcome; any other rejection is a failure.
          this.#metrics?.recordWrite(prep.outcome === "forkGuard" ? "forked" : "failed");
          throw new Error(`snapshot prepare rejected: ${prep.outcome}`);
        }
        prepared = true;
        if (this.#hooks?.afterPrepare) {
          await this.#hooks.afterPrepare();
        }
        callbackReturned = true;
        return value;
      });
    } catch (error) {
      // A throw from inside the callback rolled the transaction back: abort the prepared unit so no
      // orphan pending record remains. A throw AFTER the callback returned is an ambiguous commit:
      // leave the unit PENDING and let the recovery worker resolve it via pg_xact_status.
      if (prepared && !callbackReturned) {
        await this.#store.abortPrepared(boundRunId, transitionToken).catch(() => undefined);
      }
      throw error;
    }

    if (!prepared) return result;

    // A throw here leaves the unit PREPARED + PENDING with Postgres committed: the interrupted state
    // recovery resolves. It is deliberately outside the try above, so it never triggers an abort.
    if (this.#hooks?.beforeFinalize) {
      await this.#hooks.beforeFinalize();
    }
    let finalizeResult;
    try {
      finalizeResult = await this.#store.finalize(boundRunId, transitionToken);
    } catch (error) {
      this.#metrics?.recordWrite("failed");
      throw error;
    }
    // Only an applied write counts as "written": a finalized unit, or an idempotent noop (a lost-reply
    // repeat of an already-applied finalize). A stale token or a baseMissing (the delayed-finalize
    // fail-closed outcome) applied nothing, so the transaction must FAIL CLOSED rather than let its
    // caller advance off a write that was never published.
    if (finalizeResult.outcome === "finalized" || finalizeResult.outcome === "noop") {
      this.#metrics?.recordWrite("written");
      return result;
    }
    this.#metrics?.recordWrite("failed");
    throw new SnapshotWriteUnavailableError(
      boundRunId,
      `finalize applied nothing (${finalizeResult.outcome})`
    );
  }

  // Forces xid8 assignment and returns it; the subsequent writes in this transaction inherit it, and
  // it is the xid pg_xact_status will report to the recovery worker.
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

  // The BIRTH residency, from the org's CURRENT dial. Off / not-enrolled is inert (postgres, plain
  // passthrough); dual-write and redis-read mirror; redis-only is redis-primary.
  #birthResidency(organizationId: string): "postgres" | "mirrored" | "redis-primary" {
    const dial = this.#resolveDial(organizationId);
    if (dial === undefined || dial === "off") return "postgres";
    // A redis-only dial mints a redis-primary run ONLY when the store is ready; otherwise it degrades to
    // a mirrored birth (still fully written to Postgres) rather than stranding a new resident on an
    // unready MemoryDB. This gates NEW births alone: existing residents follow durable residency.
    if (dial === "redis-only") return this.#redisPrimaryBirthReady() ? "redis-primary" : "mirrored";
    return "mirrored";
  }

  // The residency a write must use. A birth follows the org's live dial (above). A transition follows
  // the RUN's IMMUTABLE durable residency, never the live dial: a redis-primary run keeps writing
  // redis-primary after the org dials down, a mirrored run keeps mirroring, so a lowered dial drains
  // rather than freezing a resident run's head. A never-enrolled org short-circuits to postgres before
  // any MemoryDB read, keeping the lowest position genuinely inert.
  async #writeResidency(
    runId: string,
    organizationId: string,
    kind: "birth" | "transition",
    routeField?: unknown
  ): Promise<"postgres" | "mirrored" | "redis-primary"> {
    if (kind === "birth") return this.#birthResidency(organizationId);
    const routePresent = routeField !== undefined && routeField !== null;
    const wire = routePresent ? parseSnapshotRoute(routeField) : undefined;
    // A never-enrolled run (NO route field) may take the inert postgres shortcut without a MemoryDB
    // read. ANY run that carries a route field (even malformed) was enrolled at birth: never shortcut
    // it — a poll-lagging dial that reads `undefined` must still resolve durable state.
    if (!routePresent && this.#resolveDial(organizationId) === undefined) return "postgres";
    let res = await this.#residencyResolver.resolve(runId);
    if (res.kind === "pendingBirth") {
      if (this.#resolvePending) await this.#resolvePending(runId);
      res = await this.#residencyResolver.resolve(runId);
    }
    switch (res.kind) {
      case "committed":
        return res.residency;
      case "absent":
        // A VALID redis route promised durable redis state that is now missing: fail closed rather
        // than divert to a Postgres row reads never consult. A postgres route, a malformed route, or
        // no route falls back to Postgres (pre-cutover compatible).
        if (wire && wire.residency !== "postgres") {
          throw new SnapshotWriteUnavailableError(
            runId,
            `route ${wire.residency} but durable state absent`
          );
        }
        return "postgres";
      // expired state, an unresolved pendingBirth, and a MemoryDB error cannot name a residency: fail
      // closed rather than guess and risk diverging a mirrored head from its Postgres copy.
      default:
        throw new SnapshotWriteUnavailableError(
          runId,
          `durable residency unresolved (${res.kind})`
        );
    }
  }

  // The versioned storage route for a run, resolved from its durable BIRTH residency, to stamp on a
  // queue message so a poll-lagging consumer honors the run's true residency. A never-enrolled org is
  // inert (undefined, no MemoryDB read); a pre-cutover / postgres run carries no route either. Never
  // throws: an unresolvable residency at enqueue is left to the consumer's on-demand resolver.
  override async readSnapshotRoute(
    runId: string,
    organizationId: string
  ): Promise<SnapshotRoute | undefined> {
    if (this.#resolveDial(organizationId) === undefined) return undefined;
    let res = await this.#residencyResolver.resolve(runId);
    if (res.kind === "pendingBirth") {
      if (this.#resolvePending) await this.#resolvePending(runId);
      res = await this.#residencyResolver.resolve(runId);
    }
    if (res.kind === "committed") {
      return { runId, organizationId, residency: res.residency };
    }
    return undefined;
  }

  // A redis-primary run's only home is MemoryDB, so the delegate writes the run mutation but no TRES
  // row and no snapshot-to-waitpoint join rows. Mirrored writes both, exactly as before.
  #withResidencyControl<S extends { writeSnapshotRow?: boolean }>(
    snapshot: S,
    residency: "mirrored" | "redis-primary"
  ): S {
    if (residency !== "redis-primary") return snapshot;
    return { ...snapshot, writeSnapshotRow: false };
  }

  // The completed-waitpoint cycle a redis-primary transition carries in MemoryDB. Mirrored writes leave
  // the cycle unset (Postgres still holds the join rows).
  async #buildCycle(
    runId: string,
    completedWaitpoints: { id: string; index?: number }[] | undefined,
    resolveRecords: (() => Promise<CompletedWaitpointRecord[]>) | undefined,
    residency: "mirrored" | "redis-primary"
  ): Promise<AppendCyclePayload | undefined> {
    if (residency !== "redis-primary") return undefined;
    if (!completedWaitpoints || completedWaitpoints.length === 0) return undefined;
    // Fresh completions arrive WITH a resolver (born at the waitpoint unblock site): fetch the records
    // lazily here — the only branch that needs them — and mint a new cycle.
    const records = resolveRecords ? await resolveRecords() : undefined;
    if (records && records.length > 0) {
      return { kind: "new", completedWaitpoints, records };
    }
    // Refs WITHOUT records is a forward-carry (dequeue/checkpoint re-propagating a prior snapshot's
    // waitpoints): point at the committed head's cycle, whose records already reproduce the Postgres
    // read; carry the refs so the store can mint-from-refs if that cycle is gone.
    const head = await this.#store.getLatest(runId);
    return { kind: "carryForward", cycleSeq: head?.cycle?.cycleSeq ?? 0, completedWaitpoints };
  }

  // The prepare protocol must own its own commit boundary, so a mirrored write can never run inside an
  // OPEN interactive transaction. But callers routinely pass a bare PrismaClient as a routing hint (so
  // the routing delegate picks the owning DB by id), not an open transaction: that is fine, because the
  // decorator ignores it and opens its own boundary via runInTransaction. The two are distinguished by
  // `$transaction`, which a full client exposes and an interactive TransactionClient does not.
  #assertOwnsCommit(tx: PrismaClientOrTransaction | undefined): void {
    if (tx !== undefined && !("$transaction" in tx)) {
      throw new Error(
        `TaskRunExecutionSnapshotStore (mode ${this.#mode}) cannot mirror a write inside a caller-supplied transaction`
      );
    }
  }
}
