import type {
  BatchTaskRun,
  BatchTaskRunItemStatus,
  Prisma,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunStatus,
} from "@trigger.dev/database";
import { ownerEngine, type Residency } from "@trigger.dev/core/v3/isomorphic";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";
import type {
  ClearIdempotencyKeyInput,
  CompletionSnapshotInput,
  CreateBatchTaskRunData,
  CreateCancelledRunInput,
  CreateExecutionSnapshotInput,
  CreateFailedRunInput,
  CreateRunInput,
  ExpireSnapshotInput,
  ForWaitpointCompletionContext,
  LockRunData,
  ReadClient,
  RescheduleSnapshotInput,
  RewriteDebouncedRunData,
  RunStore,
  TaskRunWithWaitpoint,
  WaitpointColocationOptions,
} from "./types.js";
import { isReadReplicaClient } from "./readReplicaClient.js";
import { CONNECTED_RUNS_LIMIT } from "./PostgresRunStore.js";

/**
 * Run-ops routing substrate for the TaskRun-core method group. Implements {@link RunStore}
 * by selecting between a NEW store (the dedicated run-ops DB, where new runs are born) and
 * a LEGACY store (the control-plane DB) via the residency classifier (`ownerEngine`:
 * run-ops id→NEW, cuid→LEGACY). In single-DB both stores are the same, so routing is a no-op
 * passthrough. Inert until the injecting seam wires it in under `isSplitEnabled()`; reads no
 * flag here. The TaskRun-core methods (create/find/findRuns + updateMetadata/clearIdempotencyKey)
 * route by residency; all other methods are mechanical residency-routing delegates.
 */
export class RoutingRunStore implements RunStore {
  readonly #new: RunStore;
  readonly #legacy: RunStore;
  readonly #classify: (id: string) => Residency;

  constructor(options: { new: RunStore; legacy: RunStore; classify?: (id: string) => Residency }) {
    this.#new = options.new;
    this.#legacy = options.legacy;
    this.#classify = options.classify ?? ownerEngine;
  }

  // A routing store spans two databases and has no single primary — routed reads resolve the
  // OWNING sub-store's primary internally (#ownPrimary).
  get primaryReadClient(): ReadClient {
    throw new Error(
      "RoutingRunStore has no single primary read client; routed reads use the owning sub-store's primary"
    );
  }

  // Map a caller-passed read client onto a routed store. The caller's client is bound to the
  // control-plane connection — the wrong database for a NEW-resident row — so it is never forwarded
  // verbatim. A WRITER/tx signals read-your-writes (the just-written row must beat replica lag), so
  // the routed read runs on the owning store's OWN primary. A caller-passed REPLICA (branded) or no
  // client keeps the owning store's replica, preserving read scaling.
  static #ownPrimary(store: RunStore, client: ReadClient | undefined): ReadClient | undefined {
    return client != null && !isReadReplicaClient(client) ? store.primaryReadClient : undefined;
  }

  // An unclassifiable id is treated as LEGACY (probe the control-plane DB rather than drop a
  // real run), matching the read-through layer's policy.
  #classifySafe(id: string): Residency {
    try {
      return this.#classify(id);
    } catch {
      return "LEGACY";
    }
  }

  // A `findRuns` caller bound to the given store (preserves `this`; the overload set isn't
  // assignable to a single call signature, so it's cast through the implementation shape). A
  // caller-passed client resolves to the store's own primary (#ownPrimary) on every call.
  #findManyOn(
    store: RunStore,
    client: ReadClient | undefined
  ): (args: unknown) => Promise<Array<Record<string, unknown>>> {
    const fn = store.findRuns as (
      args: unknown,
      client?: ReadClient
    ) => Promise<Array<Record<string, unknown>>>;
    const resolved = RoutingRunStore.#ownPrimary(store, client);
    return (args: unknown) => fn.call(store, args, resolved);
  }

  // Route an existing run-ops id by residency. Throws on an unclassifiable id.
  #route(id: string): RunStore {
    return this.#classify(id) === "NEW" ? this.#new : this.#legacy;
  }

  // Best-effort route; falls back to NEW (the steady-state home) when the id is absent.
  // Classification is total (any id without the v1 version marker is LEGACY), so the
  // catch below only guards injected classifiers that still throw.
  #routeOrNew(id: string | undefined): RunStore {
    if (typeof id !== "string") {
      return this.#new;
    }
    try {
      return this.#route(id);
    } catch {
      return this.#new;
    }
  }

  // WRITE routing is pure id-shape (cuid → LEGACY, run-ops id → NEW). A LEGACY-classified id is
  // always LEGACY-resident; no marker check exists. Kept async so the many
  // `await this.#routeForWrite(...)` call sites need no edits (awaiting a resolved store is
  // a no-op).
  async #routeForWrite(id: string): Promise<RunStore> {
    return this.#route(id);
  }

  async #routeOrNewForWrite(id: string | undefined): Promise<RunStore> {
    return this.#routeOrNew(id);
  }

  // Resolve the store that OWNS the run and open ONE transaction on ITS own client. The
  // co-resident multi-write unit (e.g. startAttempt + createExecutionSnapshot) runs against the
  // tx-bound store the owner yields, so both writes share one transaction on the run's DB and a
  // failure between them rolls BOTH back. This is NOT a cross-DB transaction — the unit is co-resident
  // by construction (all writes target the one run on the one owning DB). Unclassifiable / absent id
  // falls back to NEW (the steady-state home), mirroring #routeOrNewForWrite.
  runInTransaction<R>(
    runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    return this.#routeOrNew(runId).runInTransaction(runId, fn);
  }

  // A waitpoint WRITE co-locates with its run by id-shape (cuid → LEGACY, run-ops id → NEW,
  // unclassifiable → LEGACY), mirroring how `blockRunWithWaitpointEdges` routes the edge by
  // run id. `tx` is forwarded only to LEGACY (same physical DB as the control-plane tx);
  // for NEW it's dropped so the row lands on NEW's own client.
  #routeWaitpointWrite(
    id: string | undefined,
    tx?: PrismaClientOrTransaction
  ): { store: RunStore; tx?: PrismaClientOrTransaction } {
    const store =
      typeof id === "string" && this.#classifySafe(id) === "NEW" ? this.#new : this.#legacy;
    return { store, tx: store === this.#legacy ? tx : undefined };
  }

  // Resolve which store ACTUALLY holds a waitpoint id: drain-on-read can relocate a cuid
  // waitpoint onto NEW while keeping its id, so probe the id-shape's home then the other.
  // `onPrimary` probes each store's own primary (read-your-writes callers; a fresh row may not
  // be on the replica yet, which would mis-resolve the store).
  async #resolveWaitpointStore(id: string | undefined, onPrimary = false): Promise<RunStore> {
    const home =
      typeof id === "string" && this.#classifySafe(id) === "NEW" ? this.#new : this.#legacy;
    if (typeof id !== "string") {
      return home;
    }
    if (
      await home.findWaitpoint({ where: { id } }, onPrimary ? home.primaryReadClient : undefined)
    ) {
      return home;
    }
    const other = home === this.#new ? this.#legacy : this.#new;
    return (await other.findWaitpoint(
      { where: { id } },
      onPrimary ? other.primaryReadClient : undefined
    ))
      ? other
      : home;
  }

  static #waitpointId(clause: unknown): string | undefined {
    const id = clause && typeof clause === "object" ? (clause as { id?: unknown }).id : undefined;
    return typeof id === "string" ? id : undefined;
  }

  // ---------------------------------------------------------------------------
  // TaskRun-core: Create — a run is born on the store named by its MINTED id-kind:
  // cuid → LEGACY, run-ops id → NEW, unclassifiable → NEW. The mint layer encodes
  // inherited residency into the id-kind, so create-by-id-shape is correct;
  // a brand-new run has no redirect marker.
  //
  // The caller's `tx` is intentionally NOT forwarded: it is the control-plane
  // client, but a residency-routed create must run on the OWNING store's own
  // client or the row lands in the wrong DB. Safe to drop — a create is a single
  // nested `taskRun.create` that joins no cross-DB transaction.
  // ---------------------------------------------------------------------------

  createRun(
    params: CreateRunInput,
    _tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    return this.#routeOrNew(params.data.id).createRun(params);
  }

  createCancelledRun(
    params: CreateCancelledRunInput,
    _tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    return this.#routeOrNew(params.data.id).createCancelledRun(params);
  }

  createFailedRun(
    params: CreateFailedRunInput,
    _tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    return this.#routeOrNew(params.data.id).createFailedRun(params);
  }

  // ---------------------------------------------------------------------------
  // TaskRun-core: Read — route existing-id lookups by residency
  // ---------------------------------------------------------------------------

  findRun<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRun<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRun(where: Prisma.TaskRunWhereInput, client?: ReadClient): Promise<TaskRun | null>;
  findRun(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: unknown; include?: unknown } | ReadClient,
    _client?: ReadClient
  ): Promise<unknown> {
    // Pass through only the select/include args; the caller's actual client object is never
    // forwarded to the routed store (the control-plane writer can't query the NEW DB). But its
    // PRESENCE is the read-your-writes signal: a client means the caller just wrote this run and
    // needs to beat replica lag, so route to the OWNING store's own primary (writer). Nothing
    // keeps the default — the owning store's replica.
    const args = selectOrIncludeArgs(argsOrClient);
    const onPrimary = readYourWrites(argsOrClient, _client);
    const id = idFromWhere(where);
    if (id !== undefined) {
      // Residency-classifiable (id/friendlyId): route to the owning store, then fall back to the
      // OTHER store on a miss.
      return this.#findRunRouted(id, where, args, onPrimary);
    }
    // Unclassifiable where (e.g. spanId, idempotencyKey): the run may live on either DB,
    // so fan out NEW-first then LEGACY rather than defaulting to NEW — defaulting silently
    // misses legacy-resident runs (span detail, idempotency-dedup probe, etc.).
    return this.#findRunUnrouted(where, args, onPrimary);
  }

  // A classifiable id names its OWNING store by id-shape, but physical residency can diverge from
  // classification (a pre-#4154 base62 run lives on #new yet classifies LEGACY). Read the owning
  // store first — a hit is a SINGLE read (the fast path) — then, ONLY on a miss, probe the OTHER
  // store before returning null, so a run whose residency ≠ its id-shape is found rather than 404'd.
  // Both legs run the SAME index-covered TaskRun lookup; the fan-out cost is paid only on the (rare)
  // miss. Mirrors #findRunUnrouted's shape but keyed on the classified owner.
  async #findRunRouted(
    id: string,
    where: Prisma.TaskRunWhereInput,
    args: unknown,
    onPrimary: boolean
  ): Promise<unknown> {
    const method = onPrimary ? "findRunOnPrimary" : "findRun";
    const owning = this.#routeOrNew(id);
    const fromOwning = await (owning[method] as (...rest: unknown[]) => Promise<unknown>)(
      where,
      args
    );
    if (fromOwning != null) {
      return fromOwning;
    }
    const other = owning === this.#new ? this.#legacy : this.#new;
    return (other[method] as (...rest: unknown[]) => Promise<unknown>)(where, args);
  }

  async #findRunUnrouted(
    where: Prisma.TaskRunWhereInput,
    args: unknown,
    onPrimary: boolean
  ): Promise<unknown> {
    const method = onPrimary ? "findRunOnPrimary" : "findRun";
    const fromNew = await (this.#new[method] as (...rest: unknown[]) => Promise<unknown>)(
      where,
      args
    );
    if (fromNew != null) {
      return fromNew;
    }
    return (this.#legacy[method] as (...rest: unknown[]) => Promise<unknown>)(where, args);
  }

  findRuns<S extends Prisma.TaskRunSelect>(
    args: {
      where: Prisma.TaskRunWhereInput;
      select: S;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>[]>;
  findRuns<I extends Prisma.TaskRunInclude>(
    args: {
      where: Prisma.TaskRunWhereInput;
      include: I;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>[]>;
  findRuns(
    args: {
      where: Prisma.TaskRunWhereInput;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: ReadClient
  ): Promise<TaskRun[]>;
  findRuns(
    args: {
      where: Prisma.TaskRunWhereInput;
      select?: unknown;
      include?: unknown;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: ReadClient
  ): Promise<unknown> {
    // SPLIT-mode fan-out across NEW + LEGACY. A `findRuns` `where` can span ids of mixed
    // residency, so we resolve each owning store and merge, preserving orderBy/take/skip.
    // The caller's client is never forwarded verbatim (it is the control-plane client); its
    // presence routes each leg to that store's OWN primary (read-your-writes), else each store
    // reads its own replica as before. NEW wins on id collisions (the copy->fence migration
    // window) so a half-migrated run is never double-reported.
    return this.#findRunsRouted(args, client);
  }

  async #findRunsRouted(args: FindRunsArgs, client?: ReadClient): Promise<unknown[]> {
    if (args.cursor) {
      // No caller paginates findRuns by Prisma cursor in split mode (the runs list
      // paginates in ClickHouse and hydrates a bounded id set). Merging cursor windows
      // across two DBs is unsound, so fail loud rather than silently mis-page.
      throw new Error(
        "RoutingRunStore.findRuns: cursor pagination is unsupported in split mode; pass a bounded id set or take/skip"
      );
    }

    const idList = idListFromWhere(args.where);
    return idList ? this.#findRunsByIdSet(args, idList, client) : this.#findRunsOpen(args, client);
  }

  // Bounded id-set (the list hydrate + engine sweeps). Query NEW for the whole set first
  // (it holds run-ops runs); probe LEGACY only for the ids NEW missed that could still live
  // there (cuid). The two id sets are disjoint by construction, so the merge needs no dedupe.
  async #findRunsByIdSet(
    args: FindRunsArgs,
    ids: string[],
    client?: ReadClient
  ): Promise<unknown[]> {
    const { args: selArgs, addedFields } = ensureProjected(args);
    // The id set already bounds the per-store result, so never push take/skip down — doing
    // so would truncate a store's page before the merge knows membership and mis-attribute
    // rows. take/skip are applied once, globally, in finalizeRows.
    const fan = { ...selArgs, take: undefined, skip: undefined };
    const findNew = this.#findManyOn(this.#new, client);
    const findLegacy = this.#findManyOn(this.#legacy, client);

    const newRows = await findNew(fan);
    const foundIds = new Set(newRows.map((r) => r.id as string));

    const toLegacy: string[] = [];
    for (const id of ids) {
      if (foundIds.has(id)) continue;
      if (this.#classifySafe(id) === "NEW") continue; // run-ops id: cannot live on LEGACY
      toLegacy.push(id);
    }

    const legacyRows = toLegacy.length > 0 ? await findLegacy(narrowToIds(fan, toLegacy)) : [];
    return finalizeRows([...newRows, ...legacyRows], args, addedFields);
  }

  // Open predicate (e.g. `{ batchId }`, `{ status, runtimeEnvironmentId }`): no id set to
  // partition, so query both stores and dedupe by id (NEW wins).
  async #findRunsOpen(args: FindRunsArgs, client?: ReadClient): Promise<unknown[]> {
    const { args: selArgs, addedFields } = ensureProjected(args);
    const fan = widenForMerge(selArgs);
    const findNew = this.#findManyOn(this.#new, client);
    const findLegacy = this.#findManyOn(this.#legacy, client);
    const [newRows, legacyRows] = await Promise.all([findNew(fan), findLegacy(fan)]);
    const byId = new Map<string, Record<string, unknown>>();
    for (const r of legacyRows) byId.set(r.id as string, r);
    for (const r of newRows) byId.set(r.id as string, r);
    return finalizeRows([...byId.values()], args, addedFields);
  }

  // Canonical grouped replacement for `Promise.all(ids.map(id => readThroughRun(id)))`: reuses
  // `findRuns`'s bounded id-set path (`#findRunsByIdSet`), so NEW is queried once for the whole set
  // and LEGACY once more only for the misses — never one round trip per id. Returns an id-keyed Map;
  // missing/duplicate ids are simply absent/collapsed.
  findRunsByIds<S extends Prisma.TaskRunSelect>(
    ids: string[],
    args: { select: S },
    client?: ReadClient
  ): Promise<Map<string, Prisma.TaskRunGetPayload<{ select: S }>>>;
  findRunsByIds<I extends Prisma.TaskRunInclude>(
    ids: string[],
    args: { include: I },
    client?: ReadClient
  ): Promise<Map<string, Prisma.TaskRunGetPayload<{ include: I }>>>;
  findRunsByIds(ids: string[], client?: ReadClient): Promise<Map<string, TaskRun>>;
  async findRunsByIds(
    ids: string[],
    argsOrClient?:
      | { select?: Record<string, unknown>; include?: Record<string, unknown> }
      | ReadClient,
    _client?: ReadClient
  ): Promise<Map<string, unknown>> {
    if (ids.length === 0) {
      return new Map();
    }
    const args = selectOrIncludeArgs(argsOrClient);
    // Mirrors `readYourWrites`'s slot recovery: when `argsOrClient` isn't a `{select|include}`
    // object it may itself BE the client (2-arg call) or be undefined with the client in the
    // 3rd slot (an explicit `(ids, undefined, client)` call, e.g. from a relation hydrator).
    const client =
      args === undefined ? ((argsOrClient as ReadClient | undefined) ?? _client) : _client;
    // Force `id` into the projection so the map can key off it, even when the caller's select
    // omits it — `findRuns` would otherwise strip it back out as an added-for-merge-only field.
    const projected = args?.select
      ? { select: { ...args.select, id: true } }
      : args?.include
        ? { include: args.include }
        : {};
    const rows = (await this.findRuns(
      { where: { id: { in: ids } }, ...projected } as FindRunsArgs,
      client
    )) as Record<string, unknown>[];
    const byId = new Map<string, unknown>();
    // Strip the id we force-injected for map keying when the caller's select did not ask for it,
    // so returned values match the declared payload type and never leak an unrequested id.
    const stripInjectedId = args?.select != null && !("id" in (args.select as object));
    for (const row of rows) {
      const key = row.id as string;
      if (stripInjectedId) {
        delete row.id;
      }
      byId.set(key, row);
    }
    return byId;
  }

  // ---------------------------------------------------------------------------
  // TaskRun-core: update-family — route by run id in params
  // ---------------------------------------------------------------------------

  async updateMetadata(
    runId: string,
    data: {
      metadata: string | null;
      metadataType?: string;
      metadataVersion: { increment: number };
      updatedAt: Date;
    },
    options: { expectedMetadataVersion?: number },
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    return (await this.#routeOrNewForWrite(runId)).updateMetadata(runId, data, options);
  }

  clearIdempotencyKey(
    params: ClearIdempotencyKeyInput,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    // `byId` has a single classifiable run id — route on it.
    if ("byId" in params && params.byId) {
      const store = this.#route(params.byId.runId);
      return store.clearIdempotencyKey(params, store === this.#legacy ? tx : undefined);
    }
    // `byFriendlyIds` / `byPredicate` can span mixed residency — fan out and sum.
    return Promise.all([
      this.#new.clearIdempotencyKey(params),
      this.#legacy.clearIdempotencyKey(params),
    ]).then(([fromNew, fromLegacy]) => ({ count: fromNew.count + fromLegacy.count }));
  }

  // ---------------------------------------------------------------------------
  // Mechanical residency-routing delegates so `implements RunStore` is satisfied and the
  // router is usable end-to-end. Do NOT add per-method create/fan-out nuance here.
  // ---------------------------------------------------------------------------

  async startAttempt<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return (await this.#routeForWrite(runId)).startAttempt(runId, data, args);
  }

  async completeAttemptSuccess<S extends Prisma.TaskRunSelect>(
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
    return (await this.#routeForWrite(runId)).completeAttemptSuccess(runId, data, args);
  }

  async recordRetryOutcome<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { machinePreset?: string; usageDurationMs: number; costInCents: number },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return (await this.#routeForWrite(runId)).recordRetryOutcome(runId, data, args);
  }

  async requeueRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return (await this.#routeForWrite(runId)).requeueRun(runId, args);
  }

  async recordBulkActionMembership(
    runId: string,
    bulkActionId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    return (await this.#routeForWrite(runId)).recordBulkActionMembership(runId, bulkActionId);
  }

  async cancelRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      completedAt?: Date;
      error: TaskRunError;
      bulkActionId?: string;
      usageDurationMs?: number;
      costInCents?: number;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return (await this.#routeForWrite(runId)).cancelRun(runId, data, args);
  }

  async failRunPermanently<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: {
      status: TaskRunStatus;
      completedAt: Date;
      error: TaskRunError;
      usageDurationMs: number;
      costInCents: number;
    },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return (await this.#routeForWrite(runId)).failRunPermanently(runId, data, args);
  }

  async expireRun<S extends Prisma.TaskRunSelect>(
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
    return (await this.#routeForWrite(runId)).expireRun(runId, data, args);
  }

  async expireRunsBatch(
    runIds: string[],
    data: { error: TaskRunError; now: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<number> {
    // Partition by id-shape: run-ops id → NEW, everything else → LEGACY. Call each store
    // only when its partition is non-empty (avoids an empty IN () clause). Sum counts.
    const newIds = runIds.filter((id) => this.#classifySafe(id) === "NEW");
    const legacyIds = runIds.filter((id) => this.#classifySafe(id) !== "NEW");
    const [fromNew, fromLegacy] = await Promise.all([
      newIds.length > 0 ? this.#new.expireRunsBatch(newIds, data) : 0,
      legacyIds.length > 0 ? this.#legacy.expireRunsBatch(legacyIds, data) : 0,
    ]);
    return fromNew + fromLegacy;
  }

  async lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>> {
    return (await this.#routeForWrite(runId)).lockRunToWorker(runId, data);
  }

  async parkPendingVersion<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { statusReason: string },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return (await this.#routeForWrite(runId)).parkPendingVersion(runId, data, args);
  }

  async promotePendingVersionRuns(
    runId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    return (await this.#routeForWrite(runId)).promotePendingVersionRuns(runId);
  }

  async suspendForCheckpoint<I extends Prisma.TaskRunInclude>(
    runId: string,
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    return (await this.#routeForWrite(runId)).suspendForCheckpoint(runId, args);
  }

  async resumeFromCheckpoint<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    return (await this.#routeForWrite(runId)).resumeFromCheckpoint(runId, args);
  }

  async rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    return (await this.#routeForWrite(runId)).rescheduleRun(runId, data);
  }

  async enqueueDelayedRun(
    runId: string,
    data: { queuedAt: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    return (await this.#routeForWrite(runId)).enqueueDelayedRun(runId, data);
  }

  async rewriteDebouncedRun(
    runId: string,
    data: RewriteDebouncedRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    return (await this.#routeForWrite(runId)).rewriteDebouncedRun(runId, data);
  }

  async pushTags(
    runId: string,
    tags: string[],
    where: { runtimeEnvironmentId: string },
    tx?: PrismaClientOrTransaction
  ): Promise<{ updatedAt: Date }> {
    return (await this.#routeForWrite(runId)).pushTags(runId, tags, where);
  }

  async pushRealtimeStream(
    runId: string,
    streamId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    return (await this.#routeForWrite(runId)).pushRealtimeStream(runId, streamId);
  }

  findRunOrThrow<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  findRunOrThrow<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I },
    client?: ReadClient
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  findRunOrThrow(where: Prisma.TaskRunWhereInput, client?: ReadClient): Promise<TaskRun>;
  findRunOrThrow(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: unknown; include?: unknown } | ReadClient,
    _client?: ReadClient
  ): Promise<unknown> {
    // The caller's client is not forwarded, but its presence signals read-your-writes → the
    // owning store's primary (writer); nothing → its replica (see findRun).
    const args = selectOrIncludeArgs(argsOrClient);
    const onPrimary = readYourWrites(argsOrClient, _client);
    const id = idFromWhere(where);
    if (id !== undefined) {
      // Residency-classifiable (id/friendlyId): route to the owning store and let it throw on miss.
      const store = this.#routeOrNew(id);
      const method = onPrimary ? "findRunOrThrowOnPrimary" : "findRunOrThrow";
      return (store[method] as (...rest: unknown[]) => Promise<unknown>)(where, args);
    }
    // Unclassifiable where (e.g. spanId): the run may live on either DB, so fan out NEW-first then
    // LEGACY rather than defaulting to NEW — defaulting silently misses legacy-resident runs and
    // throws a spurious not-found (must mirror findRun's #findRunUnrouted fan-out).
    return this.#findRunOrThrowUnrouted(where, args, onPrimary);
  }

  async #findRunOrThrowUnrouted(
    where: Prisma.TaskRunWhereInput,
    args: unknown,
    onPrimary: boolean
  ): Promise<unknown> {
    const probe = onPrimary ? "findRunOnPrimary" : "findRun";
    const fromNew = await (this.#new[probe] as (...rest: unknown[]) => Promise<unknown>)(
      where,
      args
    );
    if (fromNew != null) {
      return fromNew;
    }
    // LEGACY is the last leg probed, so it owns the canonical not-found throw when both DBs miss.
    const throwMethod = onPrimary ? "findRunOrThrowOnPrimary" : "findRunOrThrow";
    return (this.#legacy[throwMethod] as (...rest: unknown[]) => Promise<unknown>)(where, args);
  }

  // Explicit read-your-writes entry points: route by residency to the owning store's PRIMARY
  // (writer), never a replica. A classifiable where routes directly; an unclassifiable one fans
  // out NEW→LEGACY on each store's primary (same policy as findRun's fan-out). Each store reads
  // its OWN writer, so no control-plane client crosses into another DB.
  findRunOnPrimary<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S }
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRunOnPrimary<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I }
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRunOnPrimary(where: Prisma.TaskRunWhereInput): Promise<TaskRun | null>;
  findRunOnPrimary(
    where: Prisma.TaskRunWhereInput,
    args?: { select?: unknown; include?: unknown }
  ): Promise<unknown> {
    const id = idFromWhere(where);
    if (id !== undefined) {
      const store = this.#routeOrNew(id);
      return (store.findRunOnPrimary as (...rest: unknown[]) => Promise<unknown>)(where, args);
    }
    return this.#findRunUnrouted(where, args, true);
  }

  findRunOrThrowOnPrimary<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S }
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  findRunOrThrowOnPrimary<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I }
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  findRunOrThrowOnPrimary(where: Prisma.TaskRunWhereInput): Promise<TaskRun>;
  findRunOrThrowOnPrimary(
    where: Prisma.TaskRunWhereInput,
    args?: { select?: unknown; include?: unknown }
  ): Promise<unknown> {
    const id = idFromWhere(where);
    if (id !== undefined) {
      const store = this.#routeOrNew(id);
      return (store.findRunOrThrowOnPrimary as (...rest: unknown[]) => Promise<unknown>)(
        where,
        args
      );
    }
    return this.#findRunOrThrowUnrouted(where, args, true);
  }

  // ---------------------------------------------------------------------------
  // run-ops persistence (snapshots / waitpoints / implicit joins / dependents / attempts /
  // checkpoints). Mechanical residency-routing delegates so `implements RunStore` is satisfied.
  // ---------------------------------------------------------------------------

  // Route by batchTaskRunId so the item co-resides with its BatchTaskRun and is visible to the batch
  // completion count/update (which route by batchTaskRunId). Routing by taskRunId would place the item
  // on the child's DB if child and batch residency ever diverge, and the batch would never complete.
  async createBatchTaskRunItem(
    data: { batchTaskRunId: string; taskRunId: string; status: BatchTaskRunItemStatus },
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    return (await this.#routeForWrite(data.batchTaskRunId)).createBatchTaskRunItem(data);
  }

  // Snapshot reads route by OWNING run id (a SnapshotId is a cuid, NOT classifiable). The owning
  // store hydrates `completedWaitpoints` from its own client only, so a cross-DB completing token's
  // OUTPUT is silently missing from the resume payload — re-resolve them across BOTH DBs.
  async findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{
    include: { completedWaitpoints: true; checkpoint: true };
  }> | null> {
    const owningStore = this.#routeOrNew(runId);
    const snapshot = await owningStore.findLatestExecutionSnapshot(
      runId,
      RoutingRunStore.#ownPrimary(owningStore, client)
    );
    if (snapshot) {
      await this.#reresolveCompletedWaitpointsCrossDb(
        snapshot as Record<string, unknown>,
        owningStore,
        client
      );
    }
    return snapshot;
  }

  // Recover any cross-DB completed waitpoint MISSING from the owning store's hydration. The
  // join (CompletedWaitpoint, co-resident with the snapshot) is the source of truth for which tokens
  // completed the run; the owning store can only hydrate the ones that live on its own DB. When every
  // join id is already present we leave the array untouched (byte-identical for single-DB / the
  // co-resident steady state — no extra fan-out write); only genuinely-missing ids are resolved
  // cross-DB and appended, so a cuid token completing a run-ops run keeps its OUTPUT on the resume.
  async #reresolveCompletedWaitpointsCrossDb(
    snapshot: Record<string, unknown>,
    owningStore: RunStore,
    client?: ReadClient
  ): Promise<void> {
    const snapshotId = snapshot.id;
    if (typeof snapshotId !== "string") {
      return;
    }
    const completed = Array.isArray(snapshot.completedWaitpoints)
      ? (snapshot.completedWaitpoints as Record<string, unknown>[])
      : [];
    const present = new Set(completed.map((w) => w.id as string));
    // The join is co-resident with the snapshot, so read it from the OWNING store (the snapshot's
    // own id is a cuid and would mis-route the both-DB `findSnapshotCompletedWaitpointIds`).
    const joinIds = await owningStore.findSnapshotCompletedWaitpointIds(
      snapshotId,
      RoutingRunStore.#ownPrimary(owningStore, client)
    );
    const missing = joinIds.filter((id) => !present.has(id));
    if (missing.length === 0) {
      return; // all completed tokens co-resident → owning-store hydration is complete
    }
    const recovered = (await this.findManyWaitpoints(
      { where: { id: { in: missing } } },
      client
    )) as Record<string, unknown>[];
    snapshot.completedWaitpoints = [...completed, ...recovered];
  }

  // A snapshot is co-resident with its run, so route by the OWNING run id when the `where` carries
  // one (the warm-restart `getExecutionSnapshotsSince` shape — both steps key on `runId`), mirroring
  // findLatestExecutionSnapshot. Without a runId (a by-snapshot-id-only lookup, snapshot ids are
  // cuids and NOT residency-classifiable) the snapshot can live on either DB, so fan out NEW→LEGACY
  // rather than hardcode #new — which strands every cuid run's #legacy snapshots.
  async findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    const runId = snapshotWhereRunId(args);
    if (runId !== undefined) {
      const store = this.#routeOrNew(runId);
      return store.findExecutionSnapshot(args, RoutingRunStore.#ownPrimary(store, client));
    }
    const fromNew = await this.#new.findExecutionSnapshot(
      args,
      RoutingRunStore.#ownPrimary(this.#new, client)
    );
    return (
      fromNew ??
      this.#legacy.findExecutionSnapshot(args, RoutingRunStore.#ownPrimary(this.#legacy, client))
    );
  }

  // Snapshot reads route by OWNING run id; merge both DBs for an open/cross-residency where.
  async findManyExecutionSnapshots<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]> {
    const runId = snapshotWhereRunId(args);
    if (runId !== undefined) {
      const store = this.#routeOrNew(runId);
      return store.findManyExecutionSnapshots(args, RoutingRunStore.#ownPrimary(store, client));
    }
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.findManyExecutionSnapshots(args, RoutingRunStore.#ownPrimary(this.#new, client)),
      this.#legacy.findManyExecutionSnapshots(
        args,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    return [...fromNew, ...fromLegacy];
  }

  async createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    // Forward the caller's control-plane tx only to the #legacy store; a #new (cross-DB) write can't
    // join it, so it's dropped there (the atomic #new path uses runInTransaction instead).
    const store = await this.#routeOrNewForWrite(input.run.id);
    return store.createExecutionSnapshot(input, store === this.#legacy ? tx : undefined);
  }

  // Snapshot ids are cuids (they always classify LEGACY), and a snapshot's CompletedWaitpoint join
  // co-locates with its run, which may live on either store, so fan out to BOTH and merge (like
  // findWaitpointCompletedSnapshotIds) rather than route by the un-classifiable snapshot id.
  async findSnapshotCompletedWaitpointIds(
    snapshotId: string,
    client?: ReadClient
  ): Promise<string[]> {
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.findSnapshotCompletedWaitpointIds(
        snapshotId,
        RoutingRunStore.#ownPrimary(this.#new, client)
      ),
      this.#legacy.findSnapshotCompletedWaitpointIds(
        snapshotId,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    return uniqueStrings([...fromNew, ...fromLegacy]);
  }

  // Snapshot-id has no residency to route on, so fan out; the snapshot lives on exactly one store, so
  // `present` is the OR and `ids` the union.
  async findSnapshotCompletedWaitpointIdsWithPresence(
    snapshotId: string,
    client?: ReadClient
  ): Promise<{ present: boolean; ids: string[] }> {
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.findSnapshotCompletedWaitpointIdsWithPresence(
        snapshotId,
        RoutingRunStore.#ownPrimary(this.#new, client)
      ),
      this.#legacy.findSnapshotCompletedWaitpointIdsWithPresence(
        snapshotId,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    return {
      present: fromNew.present || fromLegacy.present,
      ids: uniqueStrings([...fromNew.ids, ...fromLegacy.ids]),
    };
  }

  // Keyed by waitpointId, but the WaitpointRunConnection / CompletedWaitpoint join co-locates with the
  // RUN/snapshot — which can be on the OTHER DB from a cross-DB token — so fan out to BOTH stores and
  // merge. Dedup by value: a token mirrored onto both DBs during drain can carry the same join
  // row on each leg. Each sub-store already caps at CONNECTED_RUNS_LIMIT, but a disjoint run set on
  // each side can still make the union exceed it, so slice again after the merge.
  async findWaitpointConnectedRunIds(waitpointId: string, client?: ReadClient): Promise<string[]> {
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.findWaitpointConnectedRunIds(
        waitpointId,
        RoutingRunStore.#ownPrimary(this.#new, client)
      ),
      this.#legacy.findWaitpointConnectedRunIds(
        waitpointId,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    return uniqueStrings([...fromNew, ...fromLegacy]).slice(0, CONNECTED_RUNS_LIMIT);
  }

  async findWaitpointCompletedSnapshotIds(
    waitpointId: string,
    client?: ReadClient
  ): Promise<string[]> {
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.findWaitpointCompletedSnapshotIds(
        waitpointId,
        RoutingRunStore.#ownPrimary(this.#new, client)
      ),
      this.#legacy.findWaitpointCompletedSnapshotIds(
        waitpointId,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    return uniqueStrings([...fromNew, ...fromLegacy]);
  }

  async blockRunWithWaitpointEdges(params: {
    runId: string;
    waitpointIds: string[];
    projectId: string;
    spanIdToComplete?: string;
    batchId?: string;
    batchIndex?: number;
    tx?: PrismaClientOrTransaction;
  }): Promise<void> {
    return (await this.#routeOrNewForWrite(params.runId)).blockRunWithWaitpointEdges(params);
  }

  // A run's waitpoints can be scattered across both stores (drain in flight), so count on
  // each and sum rather than assume one home.
  async countPendingWaitpoints(waitpointIds: string[], client?: ReadClient): Promise<number> {
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.countPendingWaitpoints(
        waitpointIds,
        RoutingRunStore.#ownPrimary(this.#new, client)
      ),
      this.#legacy.countPendingWaitpoints(
        waitpointIds,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    return fromNew + fromLegacy;
  }

  // A waitpoint co-locates with the OWNER it points at, in priority order: an explicit
  // `coLocateWithRunId` (a DATETIME/MANUAL wait waitpoint co-locating with the run that blocks on
  // it — its minted id is always cuid, so id-shape alone always misroutes it to LEGACY), then a
  // RUN-completion owner via `completedByTaskRunId`, then a BATCH owner via
  // `completedByBatchId` (the control-plane Waitpoint→BatchTaskRun FK requires it to share the
  // batch's DB). Else fall back to the waitpoint's own id-shape.
  createWaitpoint<T extends Prisma.WaitpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointCreateArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    const data = (args as { data?: unknown }).data;
    const ownerRunId = scalarStringField(data, "completedByTaskRunId");
    const ownerBatchId = scalarStringField(data, "completedByBatchId");
    const routeId =
      opts?.coLocateWithRunId ?? ownerRunId ?? ownerBatchId ?? RoutingRunStore.#waitpointId(data);
    const { store, tx: routedTx } = this.#routeWaitpointWrite(routeId, tx);
    return store.createWaitpoint(args, routedTx);
  }

  upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    // `coLocateWithRunId` (the owning run) wins so a DATETIME/MANUAL wait waitpoint lands on its
    // run's DB; otherwise key by create.id (always the minted waitpoint id), then where.
    const routeId =
      opts?.coLocateWithRunId ??
      RoutingRunStore.#waitpointId((args as { create?: unknown }).create) ??
      RoutingRunStore.#waitpointId((args as { where?: unknown }).where);
    const { store, tx: routedTx } = this.#routeWaitpointWrite(routeId, tx);
    return store.upsertWaitpoint(args, routedTx);
  }

  // Probe by id (drain may have relocated it); an idempotency-key lookup with no id routes by
  // `coLocateWithRunId` (the owning run's store — a per-run dedup of a co-resident wait), else
  // falls back to NEW-then-LEGACY.
  async findWaitpoint<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>,
    client?: ReadClient,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    // A waitpoint's blockingTaskRuns / connectedRuns / completedExecutionSnapshots all co-locate with
    // the RUN/snapshot, not the waitpoint (the edge + join rows are written on the run's DB). So the
    // store that holds the waitpoint hydrates them from its own client only and MISSES a cross-DB
    // target (engine.getWaitpoint includes blockingTaskRuns→taskRun). Strip those keys from the
    // per-leg query and re-resolve them across BOTH DBs here, mirroring findManyTaskRunWaitpoints.
    const { scalarArgs, relations } = splitWaitpointRelationProjection(
      args as Record<string, unknown>
    );
    const id = RoutingRunStore.#waitpointId((args as { where?: unknown }).where);
    const store =
      id !== undefined
        ? await this.#resolveWaitpointStore(id, client !== undefined)
        : opts?.coLocateWithRunId !== undefined
          ? this.#routeOrNew(opts.coLocateWithRunId)
          : undefined;
    const row =
      store !== undefined
        ? ((await store.findWaitpoint(
            scalarArgs as typeof args,
            RoutingRunStore.#ownPrimary(store, client)
          )) as Record<string, unknown> | null)
        : (((await this.#new.findWaitpoint(
            scalarArgs as typeof args,
            RoutingRunStore.#ownPrimary(this.#new, client)
          )) ??
            (await this.#legacy.findWaitpoint(
              scalarArgs as typeof args,
              RoutingRunStore.#ownPrimary(this.#legacy, client)
            ))) as Record<string, unknown> | null);
    if (row) {
      await this.#reresolveWaitpointRelationsCrossDb(row, relations, client);
    }
    return row as Prisma.WaitpointGetPayload<T> | null;
  }

  // Read-after-write on the owning store's primary. Only the unblock re-read uses this — a bare
  // `{ where: { id } }` with no relation projection — so it routes to the owning store by id and
  // delegates, skipping the cross-DB relation re-resolution findWaitpoint does.
  async findWaitpointOnPrimary<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    const id = RoutingRunStore.#waitpointId((args as { where?: unknown }).where);
    const store = id !== undefined ? await this.#resolveWaitpointStore(id, true) : this.#new;
    return store.findWaitpointOnPrimary(args);
  }

  async findManyWaitpoints<T extends Prisma.WaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.WaitpointGetPayload<T>[]> {
    const { scalarArgs, relations } = splitWaitpointRelationProjection(
      args as Record<string, unknown>
    );
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.findManyWaitpoints(
        scalarArgs as typeof args,
        RoutingRunStore.#ownPrimary(this.#new, client)
      ),
      this.#legacy.findManyWaitpoints(
        scalarArgs as typeof args,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    // A token mirrored onto both DBs during drain appears in BOTH legs; dedup by id with NEW-wins
    // (the NEW copy is authoritative once a run migrates), matching the router's NEW-wins invariant
    // (#findRunsOpen). Without this, edge-waitpoint hydration could read a stale LEGACY status and
    // strand the run. Rows whose projection omits `id` can't be deduped and pass through.
    const byId = new Map<string, Prisma.WaitpointGetPayload<T>>();
    const passthrough: Prisma.WaitpointGetPayload<T>[] = [];
    for (const w of [...fromLegacy, ...fromNew]) {
      const id = (w as { id?: unknown }).id;
      if (typeof id === "string") byId.set(id, w);
      else passthrough.push(w);
    }
    const rows = [...byId.values(), ...passthrough];
    for (const row of rows) {
      await this.#reresolveWaitpointRelationsCrossDb(
        row as Record<string, unknown>,
        relations,
        client
      );
    }
    return rows;
  }

  // Re-resolve a waitpoint's group-A relations across BOTH DBs and attach them to `row`. Each target
  // co-locates with the RUN/snapshot (the edge + join rows live on the run's DB), so the join is read
  // from EACH store and the targets resolved via the router's existing both-DB fan-out. A no-op when no
  // group-A relation was requested (the byte-identical scalar path).
  async #reresolveWaitpointRelationsCrossDb(
    row: Record<string, unknown>,
    relations: Partial<Record<WaitpointRelationKey, SubProjection>>,
    client?: ReadClient
  ): Promise<void> {
    const waitpointId = row.id;
    if (typeof waitpointId !== "string") {
      return;
    }
    if ("blockingTaskRuns" in relations) {
      row.blockingTaskRuns = await this.#reresolveBlockingTaskRunsCrossDb(
        waitpointId,
        relations.blockingTaskRuns,
        client
      );
    }
    if ("connectedRuns" in relations) {
      row.connectedRuns = await this.#reresolveConnectedRunsCrossDb(
        waitpointId,
        relations.connectedRuns,
        client
      );
    }
    if ("completedExecutionSnapshots" in relations) {
      row.completedExecutionSnapshots = await this.#reresolveCompletedExecutionSnapshotsCrossDb(
        waitpointId,
        relations.completedExecutionSnapshots,
        client
      );
    }
  }

  // blockingTaskRuns are the TaskRunWaitpoint edges keyed by waitpointId — already a both-DB read with
  // an optional nested `taskRun` re-resolved cross-DB (findManyTaskRunWaitpoints). The edge co-locates
  // with the run, so a single store misses a cross-DB run's edge; the both-DB read recovers it.
  async #reresolveBlockingTaskRunsCrossDb(
    waitpointId: string,
    projection: SubProjection,
    client?: ReadClient
  ): Promise<unknown[]> {
    const edgeArgs = projectionAsArgs(projection) ?? {};
    return this.findManyTaskRunWaitpoints(
      {
        ...(edgeArgs as Prisma.TaskRunWaitpointFindManyArgs),
        where: { waitpointId },
      },
      client
    );
  }

  // connectedRuns: the WaitpointRunConnection join co-locates with the run, so read the connected run
  // ids from EACH store, then resolve the TaskRun rows in ONE grouped, residency-partitioned read
  // (`findRunsByIds`) and reorder to match `runIds` (the join's own order).
  async #reresolveConnectedRunsCrossDb(
    waitpointId: string,
    projection: SubProjection,
    client?: ReadClient
  ): Promise<unknown[]> {
    const runIds = await this.findWaitpointConnectedRunIds(waitpointId, client);
    const args = projectionAsArgs(projection);
    const findRunsByIds = (
      this.findRunsByIds as (...rest: unknown[]) => Promise<Map<string, unknown>>
    ).bind(this);
    const byId = runIds.length > 0 ? await findRunsByIds(runIds, args, client) : new Map();
    return runIds.map((id) => byId.get(id)).filter((run) => run != null);
  }

  // completedExecutionSnapshots: the CompletedWaitpoint join co-locates with the snapshot/run, so read
  // the snapshot ids from EACH store, then resolve the snapshot rows across BOTH DBs.
  async #reresolveCompletedExecutionSnapshotsCrossDb(
    waitpointId: string,
    projection: SubProjection,
    client?: ReadClient
  ): Promise<unknown[]> {
    const snapshotIds = await this.findWaitpointCompletedSnapshotIds(waitpointId, client);
    if (snapshotIds.length === 0) {
      return [];
    }
    const findArgs = projectionAsArgs(projection) ?? {};
    return this.findManyExecutionSnapshots(
      {
        ...(findArgs as Prisma.TaskRunExecutionSnapshotFindManyArgs),
        where: { id: { in: snapshotIds } },
      },
      client
    );
  }

  async updateWaitpoint<T extends Prisma.WaitpointUpdateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpdateArgs>,
    tx?: PrismaClientOrTransaction,
    opts?: WaitpointColocationOptions
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    // An update keyed by waitpoint id resolves to where the row lives; a `coLocateWithRunId` hint
    // (the idempotency-key rotation arm, where the row was just co-located with its run) routes by
    // the owning run's store.
    const id = RoutingRunStore.#waitpointId((args as { where?: unknown }).where);
    const store =
      id !== undefined
        ? await this.#resolveWaitpointStore(id)
        : opts?.coLocateWithRunId !== undefined
          ? this.#routeOrNew(opts.coLocateWithRunId)
          : await this.#resolveWaitpointStore(undefined);
    return store.updateWaitpoint(args, store === this.#legacy ? tx : undefined);
  }

  async updateManyWaitpoints(
    args: Prisma.WaitpointUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    const id = RoutingRunStore.#waitpointId(args.where);
    if (id !== undefined) {
      const store = await this.#resolveWaitpointStore(id);
      return store.updateManyWaitpoints(args, store === this.#legacy ? tx : undefined);
    }
    // No single routable id (batch where): apply to both stores and sum.
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.updateManyWaitpoints(args),
      this.#legacy.updateManyWaitpoints(args),
    ]);
    return { count: fromNew.count + fromLegacy.count };
  }

  // Residency guard: selects the owning store by waitpointId.
  async forWaitpointCompletion(
    waitpointId: string,
    context: ForWaitpointCompletionContext
  ): Promise<RunStore> {
    // Preferred store: explicit legacy-authority pins first, else the waitpoint's id-shape.
    const preferred =
      context.treeOwnerResidency === "LEGACY" ||
      context.isCrossTreeIdempotency === true ||
      context.hasLegacyParent === true
        ? this.#legacy
        : this.#classifySafe(waitpointId) === "NEW"
          ? this.#new
          : this.#legacy;
    // Resolve to where the waitpoint ACTUALLY lives: a migrated run's waitpoint can be on NEW
    // with a LEGACY-classified id (or vice versa), so verify and fall back rather than route
    // by id-shape alone and miss it (which leaves the blocked run stuck forever). This guard
    // selects the store a WRITE (updateManyWaitpoints) then lands on, so it must probe each
    // store's PRIMARY (mirroring #resolveWaitpointStore's onPrimary): a just-created waitpoint the
    // replica hasn't caught up on would otherwise mis-resolve the owner and strand the run.
    if (
      await preferred.findWaitpoint({ where: { id: waitpointId } }, preferred.primaryReadClient)
    ) {
      return preferred;
    }
    const other = preferred === this.#new ? this.#legacy : this.#new;
    if (await other.findWaitpoint({ where: { id: waitpointId } }, other.primaryReadClient)) {
      return other;
    }
    return preferred;
  }

  // An edge (TaskRunWaitpoint) co-locates with its RUN, not its waitpoint, so a read keyed by
  // `waitpointId` (the completion fan-out) OR `taskRunId` must query BOTH stores and dedup by
  // edge `id` — routing to where the waitpoint lives would miss an edge on the run's DB and
  // strand that run forever. Dedup is a no-op in steady state; it guards the copy→fence window.
  //
  // The edge's `waitpoint`/`taskRun` relations can also straddle DBs (a cuid MANUAL/DATETIME token
  // blocking a run-ops run; a drain-relocated token). A single store hydrates them from its own
  // client only → a cross-DB target resolves to null → the run hangs or its resume
  // output is silently dropped. So the router strips those relation keys from the per-leg
  // query (scalar edges only) and re-resolves them across BOTH stores here.
  async findManyTaskRunWaitpoints<T extends Prisma.TaskRunWaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunWaitpointFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunWaitpointGetPayload<T>[]> {
    const { scalarArgs, waitpoint, taskRun } = splitEdgeRelationProjection(
      args as Record<string, unknown>
    );

    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.findManyTaskRunWaitpoints(
        scalarArgs as typeof args,
        RoutingRunStore.#ownPrimary(this.#new, client)
      ),
      this.#legacy.findManyTaskRunWaitpoints(
        scalarArgs as typeof args,
        RoutingRunStore.#ownPrimary(this.#legacy, client)
      ),
    ]);
    const edges = dedupeEdgesById([...fromNew, ...fromLegacy]) as Record<string, unknown>[];

    if (waitpoint) {
      await this.#hydrateEdgeWaitpointsCrossDb(edges, waitpoint, client);
    }
    if (taskRun) {
      await this.#hydrateEdgeTaskRunsCrossDb(edges, taskRun, client);
    }
    return edges as Prisma.TaskRunWaitpointGetPayload<T>[];
  }

  // Resolve each edge's `waitpoint` from its scalar `waitpointId` across BOTH stores (the token can
  // live on either DB). A blocking edge whose waitpoint resolves on NEITHER DB is a hard error: the
  // run would otherwise hang forever (or be wrongly treated as completed) on a null status.
  async #hydrateEdgeWaitpointsCrossDb(
    edges: Record<string, unknown>[],
    projection: SubProjection,
    client?: ReadClient
  ): Promise<void> {
    const ids = uniqueStrings(edges.map((e) => e.waitpointId));
    if (ids.length === 0) {
      return;
    }
    const waitpoints = (await this.findManyWaitpoints(
      { where: { id: { in: ids } } },
      client
    )) as Record<string, unknown>[];
    const byId = new Map(waitpoints.map((w) => [w.id as string, w]));
    for (const edge of edges) {
      const id = edge.waitpointId as string | undefined;
      const wp = id ? byId.get(id) : undefined;
      if (id && !wp) {
        throw new Error(
          `findManyTaskRunWaitpoints: blocking waitpoint ${id} (edge ${String(
            edge.id
          )}) not found on either run-ops DB`
        );
      }
      edge.waitpoint = applyEdgeProjection(wp ?? null, projection);
    }
  }

  // Resolve every edge's `taskRun` from its scalar `taskRunId` in ONE grouped, residency-partitioned
  // read (`findRunsByIds`) rather than one `findRun` per edge. A missing run is left null
  // (display-only callers tolerate it; the blocked-run resume path keys off `waitpoint`).
  async #hydrateEdgeTaskRunsCrossDb(
    edges: Record<string, unknown>[],
    projection: SubProjection,
    client?: ReadClient
  ): Promise<void> {
    const ids = uniqueStrings(edges.map((e) => e.taskRunId));
    const args = projectionAsArgs(projection);
    // Bind to `this`: findRunsByIds reaches private members, so an unbound reference throws.
    const findRunsByIds = (
      this.findRunsByIds as (...rest: unknown[]) => Promise<Map<string, unknown>>
    ).bind(this);
    const byId =
      ids.length > 0 ? await findRunsByIds(ids, args, client) : new Map<string, unknown>();
    for (const edge of edges) {
      const id = edge.taskRunId as string | undefined;
      const run = id ? byId.get(id) : undefined;
      edge.taskRun = applyEdgeProjection((run as Record<string, unknown>) ?? null, projection);
    }
  }

  async deleteManyTaskRunWaitpoints(
    args: Prisma.TaskRunWaitpointDeleteManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    const where = args.where as { waitpointId?: unknown } | undefined;
    const waitpointId = typeof where?.waitpointId === "string" ? where.waitpointId : undefined;
    if (waitpointId !== undefined) {
      const store = await this.#resolveWaitpointStore(waitpointId);
      return store.deleteManyTaskRunWaitpoints(args, store === this.#legacy ? tx : undefined);
    }
    // Keyed by taskRunId (or other): a run's edges may straddle DBs mid-drain, so delete from both.
    // One tx can't span two DBs, so the #new leg is auto-commit; the caller's tx is control-plane, so
    // the #legacy leg keeps it (atomic with the caller's op, matching the waitpointId-keyed path).
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.deleteManyTaskRunWaitpoints(args),
      this.#legacy.deleteManyTaskRunWaitpoints(args, tx),
    ]);
    return { count: fromNew.count + fromLegacy.count };
  }

  findTaskRunAttempt<T extends Prisma.TaskRunAttemptFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunAttemptFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunAttemptGetPayload<T> | null> {
    const runId = whereFieldString(args.where?.taskRunId as Prisma.TaskRunWhereInput["id"]);
    if (runId !== undefined) {
      // Residency-classifiable run id present: route to the owning store. Never forward the
      // caller's client verbatim (it is the control-plane handle); its presence resolves to the
      // owning store's OWN primary.
      const store = this.#routeOrNew(runId);
      return store.findTaskRunAttempt(args, RoutingRunStore.#ownPrimary(store, client));
    }
    // No classifiable run id (no taskRunId, or complex filter): fan out NEW-first → LEGACY.
    return this.#findTaskRunAttemptUnrouted(args, client);
  }

  async #findTaskRunAttemptUnrouted<T extends Prisma.TaskRunAttemptFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunAttemptFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunAttemptGetPayload<T> | null> {
    const fromNew = await this.#new.findTaskRunAttempt(
      args,
      RoutingRunStore.#ownPrimary(this.#new, client)
    );
    if (fromNew != null) {
      return fromNew;
    }
    return this.#legacy.findTaskRunAttempt(args, RoutingRunStore.#ownPrimary(this.#legacy, client));
  }

  // Co-locate the checkpoint with its OWNING run so the run-routed snapshot's `checkpointId` FK
  // resolves on the same DB. Route by `ownerRunId`; tx forwards only to LEGACY.
  async createTaskRunCheckpoint<T extends Prisma.TaskRunCheckpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunCheckpointCreateArgs>,
    ownerRunId?: string,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunCheckpointGetPayload<T>> {
    const store = this.#routeOrNew(ownerRunId);
    return store.createTaskRunCheckpoint(args, ownerRunId, store === this.#legacy ? tx : undefined);
  }

  // ---------------------------------------------------------------------------
  // BatchTaskRun (run-ops). Route by id-shape: run-ops id→NEW, cuid→LEGACY.
  // ---------------------------------------------------------------------------

  async createBatchTaskRun(
    data: CreateBatchTaskRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<BatchTaskRun> {
    // Route by the batch's classifiable internal id: run-ops id→NEW, cuid→LEGACY.
    // Never forward a control-plane tx to NEW (the create would land in the wrong DB, stranding the
    // run-ops batch + its co-resident child runs/items); forward tx only to LEGACY (same physical DB
    // as the tx). Mirrors #routeWaitpointWrite / updateBatchTaskRun.
    const store = await this.#routeOrNewForWrite(data.id);
    return store.createBatchTaskRun(data, store === this.#legacy ? tx : undefined);
  }

  updateBatchTaskRun<S extends Prisma.BatchTaskRunSelect>(
    args: {
      where: Prisma.BatchTaskRunWhereUniqueInput;
      data: Prisma.BatchTaskRunUpdateInput;
      select: S;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchTaskRunGetPayload<{ select: S }>> {
    const id =
      typeof args.where.id === "string" ? args.where.id : (args.where.friendlyId ?? undefined);
    // Never forward a control-plane tx to NEW (it would update the wrong DB and the row would
    // not be found); forward tx only to LEGACY (same physical DB as the tx). Mirrors #routeWaitpointWrite.
    const store = this.#routeOrNew(id);
    return store.updateBatchTaskRun(args, store === this.#legacy ? tx : undefined);
  }

  // Batches can be written to either DB by different create paths (runEngine routes by id;
  // batchTriggerV3 writes raw to the control-plane), so probe NEW first then LEGACY rather
  // than strict id-routing, which would miss a run-ops-id batch resident on the control-plane.
  async findBatchTaskRunById<T extends Prisma.BatchTaskRunInclude = {}>(
    id: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    // Never forward the caller's client verbatim (a cross-DB probe with one shared client can
    // only reach one DB); its presence resolves each leg to that store's OWN primary.
    const fromNew = await this.#new.findBatchTaskRunById(
      id,
      args,
      RoutingRunStore.#ownPrimary(this.#new, client)
    );
    if (fromNew != null) return fromNew;
    return this.#legacy.findBatchTaskRunById(
      id,
      args,
      RoutingRunStore.#ownPrimary(this.#legacy, client)
    );
  }

  // Env-scoped friendlyId probe; no id-routing because cuid-on-NEW window batches exist.
  async findBatchTaskRunByFriendlyId<T extends Prisma.BatchTaskRunInclude = {}>(
    friendlyId: string,
    environmentId: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    // Never forward the caller's client verbatim; its presence resolves each leg to that
    // store's OWN primary.
    const fromNew = await this.#new.findBatchTaskRunByFriendlyId(
      friendlyId,
      environmentId,
      args,
      RoutingRunStore.#ownPrimary(this.#new, client)
    );
    if (fromNew != null) return fromNew;
    return this.#legacy.findBatchTaskRunByFriendlyId(
      friendlyId,
      environmentId,
      args,
      RoutingRunStore.#ownPrimary(this.#legacy, client)
    );
  }

  // ---------------------------------------------------------------------------
  // Batch residency — route every batch op by the batch id so a run-ops id
  // batch + its items co-reside on NEW with its child runs (the TaskRun.batchId and
  // BatchTaskRunItem.batchTaskRunId FKs resolve locally).
  // ---------------------------------------------------------------------------

  // Idempotency probe — no classifiable id (env+key), so fan out NEW→LEGACY.
  async findBatchTaskRunByIdempotencyKey<T extends Prisma.BatchTaskRunInclude = {}>(
    environmentId: string,
    idempotencyKey: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    // Never forward the caller's client verbatim; its presence resolves each leg to that
    // store's OWN primary.
    const fromNew = await this.#new.findBatchTaskRunByIdempotencyKey(
      environmentId,
      idempotencyKey,
      args,
      RoutingRunStore.#ownPrimary(this.#new, client)
    );
    if (fromNew != null) return fromNew;
    return this.#legacy.findBatchTaskRunByIdempotencyKey(
      environmentId,
      idempotencyKey,
      args,
      RoutingRunStore.#ownPrimary(this.#legacy, client)
    );
  }

  // Route by `where.id` when scalar; else (e.g. status filter) fan out to both and sum.
  async updateManyBatchTaskRun(
    args: Prisma.BatchTaskRunUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    const id = RoutingRunStore.#scalarId(args.where);
    if (id !== undefined) {
      const store = this.#routeOrNew(id);
      return store.updateManyBatchTaskRun(args, store === this.#legacy ? tx : undefined);
    }
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.updateManyBatchTaskRun(args),
      this.#legacy.updateManyBatchTaskRun(args),
    ]);
    return { count: fromNew.count + fromLegacy.count };
  }

  // Items co-reside with their batch — route by `batchTaskRunId`, no fan-out.
  countBatchTaskRunItems(
    where: { batchTaskRunId: string; status?: BatchTaskRunItemStatus },
    client?: ReadClient
  ): Promise<number> {
    // Never forward the caller's client verbatim (a run-ops batch routes to NEW, so a forwarded
    // control-plane client would count items on the wrong DB → 0/wrong count); its presence
    // resolves to the owning store's OWN primary.
    const store = this.#routeOrNew(where.batchTaskRunId);
    return store.countBatchTaskRunItems(where, RoutingRunStore.#ownPrimary(store, client));
  }

  // Route by item `id` or `batchTaskRunId` when scalar; else fan out to both and sum.
  async updateManyBatchTaskRunItems(
    args: Prisma.BatchTaskRunItemUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    // Items co-reside with their batch; route by batchTaskRunId (residency-encoding) first. The item
    // id is a cuid that always classifies LEGACY, so leading with it misroutes a NEW batch's items.
    const id =
      RoutingRunStore.#scalarField(args.where, "batchTaskRunId") ??
      RoutingRunStore.#scalarId(args.where);
    if (id !== undefined) {
      const store = this.#routeOrNew(id);
      return store.updateManyBatchTaskRunItems(args, store === this.#legacy ? tx : undefined);
    }
    const [fromNew, fromLegacy] = await Promise.all([
      this.#new.updateManyBatchTaskRunItems(args),
      this.#legacy.updateManyBatchTaskRunItems(args),
    ]);
    return { count: fromNew.count + fromLegacy.count };
  }

  // Extract a scalar string `id` from a `{ id }` / `{ id: { equals } }` where; undefined otherwise.
  static #scalarId(where: unknown): string | undefined {
    return RoutingRunStore.#scalarField(where, "id");
  }

  static #scalarField(where: unknown, field: string): string | undefined {
    if (!where || typeof where !== "object") return undefined;
    const value = (where as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && "equals" in value) {
      const eq = (value as { equals?: unknown }).equals;
      return typeof eq === "string" ? eq : undefined;
    }
    return undefined;
  }
}

// Distinguish a select/include args object from a ReadClient in the overloaded read
// signatures: only an args object carries `select`/`include`. Returns the args (to pass
// through) or undefined (so the routed store uses its own client), never the client.
function selectOrIncludeArgs(
  argsOrClient: { select?: unknown; include?: unknown } | unknown
): { select?: unknown; include?: unknown } | undefined {
  if (
    argsOrClient &&
    typeof argsOrClient === "object" &&
    ("select" in argsOrClient || "include" in argsOrClient)
  ) {
    return argsOrClient as { select?: unknown; include?: unknown };
  }
  return undefined;
}

// A read-your-writes call passes a WRITER or ambient tx, whose just-written row must be read back
// before the replica has it. Recover the caller's client from the overloaded read args — slot two
// when it isn't a `{ select | include }` object, else slot three — and report whether it warrants
// escalation to the owning primary. A branded replica does NOT: it can't be forwarded across DBs,
// but it signals a replica-intended read, so the owning store keeps its own replica (read scaling).
function readYourWrites(
  argsOrClient: { select?: unknown; include?: unknown } | ReadClient | unknown,
  client: ReadClient | undefined
): boolean {
  const passedClient =
    selectOrIncludeArgs(argsOrClient) === undefined ? (argsOrClient ?? client) : client;
  return passedClient != null && !isReadReplicaClient(passedClient);
}

// Read a plain scalar string field off a create-data object (e.g. `data.completedByTaskRunId`).
function scalarStringField(data: unknown, field: string): string | undefined {
  if (!data || typeof data !== "object") {
    return undefined;
  }
  const value = (data as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function whereFieldString(field: Prisma.TaskRunWhereInput["id"]): string | undefined {
  if (typeof field === "string") {
    return field;
  }
  if (field && typeof field === "object" && "equals" in field && typeof field.equals === "string") {
    return field.equals;
  }
  return undefined;
}

// Extract a scalar `runId` from a snapshot find `args.where` (the warm-restart reads key on it).
function snapshotWhereRunId(args: unknown): string | undefined {
  const where = args && typeof args === "object" ? (args as { where?: unknown }).where : undefined;
  if (!where || typeof where !== "object") {
    return undefined;
  }
  return whereFieldString((where as { runId?: Prisma.TaskRunWhereInput["id"] }).runId);
}

function idFromWhere(where: Prisma.TaskRunWhereInput): string | undefined {
  // Route by internal id when present, else by friendlyId. Both classify identically
  // (the classifier strips the `run_` prefix), so a read keyed on friendlyId (the common
  // presenter case) routes to the owning store instead of falling back to the new store.
  return whereFieldString(where.id) ?? whereFieldString(where.friendlyId);
}

type FindRunsArgs = {
  where: Prisma.TaskRunWhereInput;
  select?: unknown;
  include?: unknown;
  orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
  take?: number;
  skip?: number;
  cursor?: Prisma.TaskRunWhereUniqueInput;
};

// The bounded internal-id set a `where` targets, or undefined for an open predicate.
// Only `id` (the residency-classifiable internal id) qualifies for the partitioned path.
function idListFromWhere(where: Prisma.TaskRunWhereInput): string[] | undefined {
  const id = where.id;
  if (typeof id === "string") return [id];
  if (id && typeof id === "object") {
    if ("in" in id && Array.isArray(id.in)) {
      const strings = id.in.filter((x): x is string => typeof x === "string");
      return strings.length === id.in.length ? strings : undefined;
    }
    if ("equals" in id && typeof id.equals === "string") return [id.equals];
  }
  return undefined;
}

function narrowToIds(args: FindRunsArgs, ids: string[]): FindRunsArgs {
  return { ...args, where: { ...args.where, id: { in: ids } } };
}

// Merge edge rows from both stores, keeping one per edge `id` (NEW seen last wins). Rows whose
// projection omits `id` can't be deduped, so they pass through unchanged.
function dedupeEdgesById<R>(rows: R[]): R[] {
  const byId = new Map<string, R>();
  const passthrough: R[] = [];
  for (const row of rows) {
    const id = (row as { id?: unknown }).id;
    if (typeof id === "string") byId.set(id, row);
    else passthrough.push(row);
  }
  return [...byId.values(), ...passthrough];
}

// A caller sub-select for an edge relation: `{ select?, include? }`, `true` for a bare `key: true`,
// or undefined when not requested.
type SubProjection = { select?: any; include?: any } | true | undefined;

// Split a TaskRunWaitpoint `findMany` args into the scalar args sent to each leg (the `waitpoint`/
// `taskRun` relation keys removed, the keying scalars + `id` ensured present) and the requested
// relation sub-projections the router resolves cross-DB.
function splitEdgeRelationProjection(args: Record<string, unknown>): {
  scalarArgs: Record<string, unknown>;
  waitpoint: SubProjection;
  taskRun: SubProjection;
} {
  const select = args.select as Record<string, unknown> | undefined;
  const include = args.include as Record<string, unknown> | undefined;

  if (select && ("waitpoint" in select || "taskRun" in select)) {
    const { waitpoint, taskRun, ...rest } = select;
    return {
      // Keep `id` (dedupe) and the keying scalars (cross-DB hydration) through a narrowed select.
      scalarArgs: {
        ...args,
        select: { ...rest, id: true, waitpointId: true, taskRunId: true },
      },
      waitpoint: waitpoint as SubProjection,
      taskRun: taskRun as SubProjection,
    };
  }
  if (include && ("waitpoint" in include || "taskRun" in include)) {
    const { waitpoint, taskRun, ...rest } = include;
    const restInclude = Object.keys(rest).length > 0 ? { include: rest } : {};
    const { include: _drop, ...base } = args;
    return {
      scalarArgs: { ...base, ...restInclude },
      waitpoint: waitpoint as SubProjection,
      taskRun: taskRun as SubProjection,
    };
  }
  // No edge relation requested: pass the args through unchanged (byte-identical scalar path).
  return { scalarArgs: args, waitpoint: undefined, taskRun: undefined };
}

// The Waitpoint group-A relation keys whose TARGETS co-locate with the RUN/snapshot, not the
// waitpoint, so a single store hydrates them from its own client and MISSES a cross-DB target
// The router strips these from the per-leg query and re-resolves them across BOTH DBs.
const WAITPOINT_RELATION_KEYS = [
  "blockingTaskRuns",
  "connectedRuns",
  "completedExecutionSnapshots",
] as const;
type WaitpointRelationKey = (typeof WAITPOINT_RELATION_KEYS)[number];

// Split a Waitpoint `findFirst`/`findMany` args into the scalar args sent to each leg (the group-A
// relation keys removed, `id` kept so the router can re-attach) and the requested relation
// sub-projections the router resolves cross-DB. Mirrors splitEdgeRelationProjection.
function splitWaitpointRelationProjection(args: Record<string, unknown>): {
  scalarArgs: Record<string, unknown>;
  relations: Partial<Record<WaitpointRelationKey, SubProjection>>;
} {
  const select = args.select as Record<string, unknown> | undefined;
  const include = args.include as Record<string, unknown> | undefined;
  const relations: Partial<Record<WaitpointRelationKey, SubProjection>> = {};

  if (select && WAITPOINT_RELATION_KEYS.some((k) => k in select)) {
    const rest: Record<string, unknown> = { ...select };
    for (const key of WAITPOINT_RELATION_KEYS) {
      if (key in rest) {
        relations[key] = rest[key] as SubProjection;
        delete rest[key];
      }
    }
    // Keep `id` so the router can re-attach the re-resolved relations to the row.
    return { scalarArgs: { ...args, select: { ...rest, id: true } }, relations };
  }
  if (include && WAITPOINT_RELATION_KEYS.some((k) => k in include)) {
    const rest: Record<string, unknown> = { ...include };
    for (const key of WAITPOINT_RELATION_KEYS) {
      if (key in rest) {
        relations[key] = rest[key] as SubProjection;
        delete rest[key];
      }
    }
    const restInclude = Object.keys(rest).length > 0 ? { include: rest } : {};
    const { include: _drop, ...base } = args;
    return { scalarArgs: { ...base, ...restInclude }, relations };
  }
  // No group-A relation requested: pass through unchanged (byte-identical scalar path).
  return { scalarArgs: args, relations };
}

// Apply an edge relation sub-projection to a hydrated row so only requested fields remain (mirrors
// PostgresRunStore.applyProjection; a `true`/undefined projection returns the full row).
function applyEdgeProjection(
  row: Record<string, unknown> | null,
  projection: SubProjection
): Record<string, unknown> | null {
  if (!row || projection === true || projection === undefined || !projection.select) {
    return row;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(projection.select)) {
    if (projection.select[k]) {
      out[k] = row[k];
    }
  }
  return out;
}

// Convert an edge relation sub-projection into `findRun`/`findRuns`-shaped args ({select}/{include}).
function projectionAsArgs(projection: SubProjection): { select?: any; include?: any } | undefined {
  if (projection === true || projection === undefined) {
    return undefined;
  }
  return projection;
}

function uniqueStrings(values: unknown[]): string[] {
  const set = new Set<string>();
  for (const v of values) {
    if (typeof v === "string") set.add(v);
  }
  return [...set];
}

// Fields the in-memory merge needs in every row: `id` (membership/dedupe) plus each scalar
// `orderBy` field (the merge re-sorts in memory, so the field must be present in the row —
// Prisma would otherwise sort it in the DB without projecting it).
function requiredProjectionFields(args: FindRunsArgs): string[] {
  const fields = new Set<string>(["id"]);
  if (args.orderBy) {
    for (const clause of Array.isArray(args.orderBy) ? args.orderBy : [args.orderBy]) {
      for (const [field, dir] of Object.entries(clause)) {
        if (dir === "asc" || dir === "desc") fields.add(field);
      }
    }
  }
  return [...fields];
}

// Guarantee the required fields are projected, returning the ones we ADDED so finalizeRows
// can strip them back out (the caller didn't ask for them).
function ensureProjected(args: FindRunsArgs): { args: FindRunsArgs; addedFields: string[] } {
  if (args.include || !args.select) return { args, addedFields: [] };
  const select = args.select as Record<string, unknown>;
  const nextSelect = { ...select };
  const added: string[] = [];
  for (const field of requiredProjectionFields(args)) {
    if (!select[field]) {
      nextSelect[field] = true;
      added.push(field);
    }
  }
  return added.length === 0
    ? { args, addedFields: [] }
    : { args: { ...args, select: nextSelect }, addedFields: added };
}

// Each store must return enough rows for the post-merge `orderBy`/`take`/`skip` to be
// re-imposed globally: drop `skip` and widen `take` to `skip + take` per store.
function widenForMerge(args: FindRunsArgs): FindRunsArgs {
  if (args.take == null && !args.skip) return args;
  const { skip, take, ...rest } = args;
  return { ...rest, take: take == null ? undefined : (skip ?? 0) + take };
}

function finalizeRows(
  rows: Array<Record<string, unknown>>,
  args: FindRunsArgs,
  addedFields: string[]
): unknown[] {
  let out = args.orderBy ? sortByOrderBy(rows, args.orderBy) : rows;
  const skip = args.skip ?? 0;
  if (skip > 0 || args.take != null) {
    out = out.slice(skip, args.take != null ? skip + args.take : undefined);
  }
  if (addedFields.length === 0) return out;
  return out.map((row) => {
    const copy = { ...row };
    for (const field of addedFields) delete copy[field];
    return copy;
  });
}

function sortByOrderBy(
  rows: Array<Record<string, unknown>>,
  orderBy: NonNullable<FindRunsArgs["orderBy"]>
): Array<Record<string, unknown>> {
  const clauses = Array.isArray(orderBy) ? orderBy : [orderBy];
  const specs: Array<{ field: string; dir: "asc" | "desc" }> = [];
  for (const clause of clauses) {
    for (const [field, dir] of Object.entries(clause)) {
      // Scalar fields only; relation/_count orderBy carries an object value and can't be
      // re-sorted in memory — left to the per-store order.
      if (dir === "asc" || dir === "desc") specs.push({ field, dir });
    }
  }
  if (specs.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { field, dir } of specs) {
      const cmp = compareValues(a[field], b[field]);
      if (cmp !== 0) return dir === "asc" ? cmp : -cmp;
    }
    return 0;
  });
}

// Scalar comparator matching Postgres byte/C-collation order for the ASCII id/friendlyId
// columns and natural order for Date/number/bigint. Nulls sort first.
function compareValues(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "bigint" && typeof b === "bigint") return a < b ? -1 : a > b ? 1 : 0;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}
