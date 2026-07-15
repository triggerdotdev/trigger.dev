import { Prisma } from "@trigger.dev/database";
import type {
  BatchTaskRun,
  BatchTaskRunItemStatus,
  PrismaClient,
  PrismaClientOrTransaction,
  TaskRun,
  TaskRunStatus,
  WaitpointTag,
} from "@trigger.dev/database";
import type {
  ClearIdempotencyKeyInput,
  CompletionSnapshotInput,
  CreateBatchTaskRunData,
  CreateCancelledRunInput,
  CreateExecutionSnapshotInput,
  CreateFailedRunInput,
  CreateRunInput,
  ExpireSnapshotInput,
  FinalizeRunData,
  ForWaitpointCompletionContext,
  IdempotencyKeyRunMatch,
  LockRunData,
  ReadClient,
  RescheduleSnapshotInput,
  RewriteDebouncedRunData,
  RunStore,
  TaskRunWithWaitpoint,
} from "./types.js";
import type { TaskRunError } from "@trigger.dev/core/v3/schemas";

// Loose delegate method shape: each generated client types delegate methods as
// `<T>(args: PackageLocalArgs<T>) => PrismaPromise<…>` against its own nominal
// `Prisma` namespace, so the full generics are mutually non-assignable. `any` args
// are the structural common denominator both clients' delegates satisfy.
// Do NOT tighten to concrete `Prisma.*Args`: it re-breaks dual-client support. The
// trade is no compile-time check of the store's call args — the testcontainers
// integration suite is the compensating control.
type RunOpsDelegate<Methods extends string> = {
  [M in Methods]: (args: any) => Promise<any>;
};

/**
 * Structural client interface covering exactly the delegates + raw methods the
 * store uses. Both `@trigger.dev/database`'s `PrismaClient` and
 * `@internal/run-ops-database`'s `RunOpsPrismaClient` are assignable to it, so
 * either can back the store; the cast from a concrete client happens once at the
 * wiring boundary.
 */
export interface RunOpsCapableClient {
  taskRun: RunOpsDelegate<
    "create" | "findFirst" | "findFirstOrThrow" | "findMany" | "update" | "updateMany"
  >;
  taskRunAttempt: RunOpsDelegate<"create" | "findFirst" | "findMany" | "update">;
  taskRunExecutionSnapshot: RunOpsDelegate<"create" | "findFirst" | "findMany">;
  taskRunWaitpoint: RunOpsDelegate<"deleteMany" | "findMany">;
  taskRunCheckpoint: RunOpsDelegate<"create">;
  checkpoint: RunOpsDelegate<"create" | "findFirst">;
  checkpointRestoreEvent: RunOpsDelegate<"create" | "findFirst">;
  taskRunDependency: RunOpsDelegate<"create" | "findFirst" | "findMany">;
  waitpoint: RunOpsDelegate<
    "create" | "findFirst" | "findMany" | "update" | "updateMany" | "upsert"
  >;
  // Dedicated-only join model (replaces the legacy implicit `_completedWaitpoints` M2M); optional
  // so the legacy client (which lacks it) stays assignable. Touched only on the dedicated branch.
  completedWaitpoint?: RunOpsDelegate<"create" | "createMany" | "findMany">;
  // Dedicated-only explicit join (replaces the legacy implicit `_WaitpointRunConnections` M2M);
  // optional so the legacy client stays assignable. Touched only on the dedicated branch.
  waitpointRunConnection?: RunOpsDelegate<"createMany" | "findMany">;
  batchTaskRun: RunOpsDelegate<"create" | "findFirst" | "update" | "updateMany">;
  batchTaskRunItem: RunOpsDelegate<"create" | "count" | "updateMany" | "findFirst" | "findMany">;
  // Standalone entity keyed by (environmentId, name); present on both schemas.
  waitpointTag: RunOpsDelegate<"upsert" | "findMany">;
  $queryRaw: PrismaClient["$queryRaw"];
  $queryRawUnsafe: PrismaClient["$queryRawUnsafe"];
  $executeRaw: PrismaClient["$executeRaw"];
}

/**
 * A writer client (never a read replica) that can open an interactive transaction on its OWN
 * connection. Both `PrismaClient` and `RunOpsPrismaClient` satisfy it; `PrismaReplicaClient` (which
 * omits `$transaction`) does NOT — only the store's `prisma` (writer) handle opens one, never
 * `readOnlyPrisma`. The tx callback's client is threaded into the store's inner writes as the
 * per-call `tx` so they share one transaction (see `runInTransaction`).
 */
export interface RunOpsTransactionalClient extends RunOpsCapableClient {
  $transaction: <R>(fn: (tx: RunOpsCapableClient) => Promise<R>) => Promise<R>;
}

/**
 * Which backing schema the supplied clients carry. `"legacy"` = the full
 * `@trigger.dev/database` schema (implicit M2M join tables + `@relation`s);
 * `"dedicated"` = the `@internal/run-ops-database` SUBSET (FK-free scalars + explicit join
 * models). The relation-shaped ops branch on this; everything else is schema-identical.
 */
export type RunStoreSchemaVariant = "legacy" | "dedicated";

// Mirrors the webapp's `CONNECTED_RUNS_DISPLAY_LIMIT`
// (apps/webapp/app/presenters/v3/WaitpointPresenter.server.ts) — keep the values in sync.
export const CONNECTED_RUNS_LIMIT = 5;

export type PostgresRunStoreOptions = {
  prisma: RunOpsCapableClient;
  readOnlyPrisma: RunOpsCapableClient;
  /** Defaults to `"legacy"` so existing callers/tests are unaffected. */
  schemaVariant?: RunStoreSchemaVariant;
};

// A caller sub-select for a relation: `{ select?, include? }` or `true` for a bare `key: true`.
type SubProjection = { select?: any; include?: any } | true | undefined;

// Hydrates one dedicated-schema relation for a WHOLE batch of parent rows in one grouped pass:
// one query for the join/target rows spanning every parent id, never one per parent. Returns a
// Map keyed by parent `id` to the already-defaulted (null / []) hydrated value.
type DedicatedRelationHydrator = (
  client: RunOpsCapableClient,
  parents: Record<string, unknown>[],
  projection: { select?: any; include?: any } | undefined,
  store: PostgresRunStore
) => Promise<Map<string, unknown>>;

// The dedicated-schema relation keys (with hydrators) for a single Prisma model.
type DedicatedRelationSpec = Record<string, DedicatedRelationHydrator>;

// Normalize a caller sub-projection to `{ select | include }` (or undefined for `true`).
function projectionOf(sub: SubProjection): { select?: any; include?: any } | undefined {
  if (sub === true || sub === undefined) {
    return undefined;
  }
  return sub;
}

// Apply a caller sub-projection to a hydrated row (or array) so only requested fields remain.
//
// Bare-projection path (no `select`): return a SHALLOW CLONE, not the row itself, so every parent
// bucket that links the same target gets a distinct top-level object — two parents sharing one
// target (e.g. two waitpoints connected to the same run) must not alias through a shared reference.
// This only protects top-level mutation; a deep in-place mutation of a nested field would still
// alias, which matches the realistic redaction/patch cases and avoids a costly deep clone on hot
// reads.
function applyProjection<T extends Record<string, unknown> | null>(
  row: T,
  projection: { select?: any; include?: any } | undefined
): T {
  if (!row) {
    return row;
  }
  if (!projection?.select) {
    return { ...row } as T;
  }
  const keys = Object.keys(projection.select).filter((k) => projection.select[k]);
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    out[k] = (row as Record<string, unknown>)[k];
  }
  return out as T;
}

/**
 * Split a caller `{ select | include }` into the args to send Prisma (dedicated-schema relation keys removed,
 * `id` ensured present so hydrators can key off it) and the `requested` map of stripped keys
 * to their sub-projection. Both `select` and `include` are handled: with `select` the parent
 * scalars must be explicitly kept, with `include` they come back by default.
 */
function stripDedicatedRelations(
  args: { select?: any; include?: any },
  spec: DedicatedRelationSpec
): { stripped: { select?: any; include?: any }; requested: Record<string, SubProjection> } {
  const requested: Record<string, SubProjection> = {};

  if (args.select) {
    const select: Record<string, unknown> = { ...args.select };
    for (const key of Object.keys(spec)) {
      if (key in select) {
        requested[key] = select[key] as SubProjection;
        delete select[key];
      }
    }
    // Hydrators key off the parent `id`; ensure it survives a narrowed select.
    select.id = true;
    return { stripped: { select }, requested };
  }

  if (args.include) {
    const include: Record<string, unknown> = { ...args.include };
    for (const key of Object.keys(spec)) {
      if (key in include) {
        requested[key] = include[key] as SubProjection;
        delete include[key];
      }
    }
    // An empty include is invalid for Prisma; drop it so the full row comes back.
    const stripped = Object.keys(include).length > 0 ? { include } : {};
    return { stripped, requested };
  }

  return { stripped: args, requested };
}

// --- per-model dedicated-schema relation hydrators (batched across the WHOLE parent array) ---

// Narrows a hydrator's target `findMany` to the caller's `select` (avoids fetching the wide
// TOASTed columns just to strip them in `applyProjection`); a bare/`include` projection stays a
// full-row fetch. `keepKeys` are the column(s) the hydrator's Map is keyed on.
function targetFindManyArgs(
  where: unknown,
  projection: { select?: any; include?: any } | undefined,
  keepKeys: string[]
): { where: unknown; select?: Record<string, unknown> } {
  if (projection?.select) {
    const select: Record<string, unknown> = { ...projection.select };
    for (const key of keepKeys) {
      select[key] = true;
    }
    return { where, select };
  }
  return { where };
}

// Generic to-many relation reached via an explicit join model: one grouped query for the join rows
// spanning every parent id, then one grouped query for the distinct target rows, then an in-memory
// (DB-free) assembly per parent. `joinParentField`/`joinTargetField` name the join row's two FK
// columns; `targetDelegate` is the model the join points at.
async function batchHydrateJoinRelation(
  join: RunOpsDelegate<"findMany"> | undefined,
  targetDelegate: RunOpsDelegate<"findMany">,
  parentIds: string[],
  joinParentField: string,
  joinTargetField: string,
  projection: { select?: any; include?: any } | undefined
): Promise<Map<string, unknown[]>> {
  const byParent = new Map<string, unknown[]>(parentIds.map((id) => [id, []]));
  if (!join || parentIds.length === 0) {
    return byParent;
  }
  const links = (await join.findMany({
    where: { [joinParentField]: { in: parentIds } },
    select: { [joinParentField]: true, [joinTargetField]: true },
  })) as Record<string, string>[];
  if (links.length === 0) {
    return byParent;
  }
  const targetIds = [...new Set(links.map((l) => l[joinTargetField]))];
  const rows = (await targetDelegate.findMany(
    targetFindManyArgs({ id: { in: targetIds } }, projection, ["id"])
  )) as Record<string, unknown>[];
  const byTargetId = new Map(rows.map((r) => [r.id as string, r]));
  for (const link of links) {
    const target = byTargetId.get(link[joinTargetField]);
    const bucket = byParent.get(link[joinParentField]);
    if (target && bucket) {
      bucket.push(applyProjection(target, projection));
    }
  }
  return byParent;
}

// Waitpoint where completedByTaskRunId = run.id (the @unique scalar back-pointer); at most one.
const hydrateAssociatedWaitpoint: DedicatedRelationHydrator = async (
  client,
  parents,
  projection
) => {
  const parentIds = parents.map((p) => p.id as string);
  const byParent = new Map<string, unknown>(parentIds.map((id) => [id, null]));
  if (parentIds.length === 0) {
    return byParent;
  }
  const rows = (await client.waitpoint.findMany(
    targetFindManyArgs({ completedByTaskRunId: { in: parentIds } }, projection, [
      "completedByTaskRunId",
    ])
  )) as Record<string, unknown>[];
  for (const row of rows) {
    const runId = row.completedByTaskRunId as string | undefined;
    if (runId && byParent.has(runId)) {
      byParent.set(runId, applyProjection(row, projection));
    }
  }
  return byParent;
};

// Display connections for a run: WaitpointRunConnection → Waitpoint rows.
const hydrateConnectedWaitpoints: DedicatedRelationHydrator = async (client, parents, projection) =>
  batchHydrateJoinRelation(
    client.waitpointRunConnection,
    client.waitpoint,
    parents.map((p) => p.id as string),
    "taskRunId",
    "waitpointId",
    projection
  );

// Completed waitpoints for a snapshot: CompletedWaitpoint join → Waitpoint rows.
const hydrateCompletedWaitpoints: DedicatedRelationHydrator = async (client, parents, projection) =>
  batchHydrateJoinRelation(
    client.completedWaitpoint,
    client.waitpoint,
    parents.map((p) => p.id as string),
    "snapshotId",
    "waitpointId",
    projection
  );

// Runs a waitpoint is blocking: TaskRunWaitpoint rows keyed by waitpointId. A nested `taskRun`
// select (the run-engine's getWaitpoint shape) is resolved from the scalar TaskRunWaitpoint.taskRunId.
const hydrateBlockingTaskRuns: DedicatedRelationHydrator = async (client, parents, projection) => {
  const parentIds = parents.map((p) => p.id as string);
  const byParent = new Map<string, unknown[]>(parentIds.map((id) => [id, []]));
  if (parentIds.length === 0) {
    return byParent;
  }
  const edges = (await client.taskRunWaitpoint.findMany({
    where: { waitpointId: { in: parentIds } },
  })) as Record<string, unknown>[];
  const nestedTaskRun = projection?.select?.taskRun;
  const runProjection = nestedTaskRun ? projectionOf(nestedTaskRun as SubProjection) : undefined;
  let byRunId = new Map<string, Record<string, unknown>>();
  if (nestedTaskRun) {
    const runIds = [...new Set(edges.map((e) => e.taskRunId as string))];
    const runs = (
      runIds.length > 0
        ? await client.taskRun.findMany(
            targetFindManyArgs({ id: { in: runIds } }, runProjection, ["id"])
          )
        : []
    ) as Record<string, unknown>[];
    byRunId = new Map(runs.map((r) => [r.id as string, r]));
  }
  for (const edge of edges) {
    const bucket = byParent.get(edge.waitpointId as string);
    if (!bucket) continue;
    bucket.push(
      nestedTaskRun
        ? {
            ...edge,
            taskRun: applyProjection(byRunId.get(edge.taskRunId as string) ?? null, runProjection),
          }
        : edge
    );
  }
  return byParent;
};

// Display connections for a waitpoint: WaitpointRunConnection → TaskRun rows. Bounded per parent to
// CONNECTED_RUNS_LIMIT via a window function + existence-JOIN to TaskRun, mirroring the id-list
// helper findWaitpointConnectedRunIds: a dangling (run-less) connection row never occupies a LIMIT
// slot, and a heavily-fanned-in waitpoint never hydrates an unbounded connectedRuns list. This is
// the DISPLAY relation only — functional blocking reads (hydrateBlockingTaskRuns) stay uncapped.
const hydrateConnectedRuns: DedicatedRelationHydrator = async (client, parents, projection) => {
  const parentIds = parents.map((p) => p.id as string);
  const byParent = new Map<string, unknown[]>(parentIds.map((id) => [id, []]));
  if (parentIds.length === 0) {
    return byParent;
  }
  // One grouped query for the bounded edges across every parent: ROW_NUMBER partitioned per
  // waitpoint keeps at most CONNECTED_RUNS_LIMIT rows per parent (uses @@index([waitpointId])).
  const links = (await client.$queryRaw`
    SELECT ranked."waitpointId" AS "waitpointId", ranked."taskRunId" AS "taskRunId"
    FROM (
      SELECT c."waitpointId", c."taskRunId",
        ROW_NUMBER() OVER (PARTITION BY c."waitpointId" ORDER BY c."id") AS rn
      FROM "WaitpointRunConnection" c
      JOIN "TaskRun" t ON t."id" = c."taskRunId"
      WHERE c."waitpointId" = ANY(${parentIds}::text[])
    ) ranked
    WHERE ranked.rn <= ${CONNECTED_RUNS_LIMIT}
  `) as { waitpointId: string; taskRunId: string }[];
  if (links.length === 0) {
    return byParent;
  }
  const targetIds = [...new Set(links.map((l) => l.taskRunId))];
  const rows = (await client.taskRun.findMany(
    targetFindManyArgs({ id: { in: targetIds } }, projection, ["id"])
  )) as Record<string, unknown>[];
  const byTargetId = new Map(rows.map((r) => [r.id as string, r]));
  for (const link of links) {
    const target = byTargetId.get(link.taskRunId);
    const bucket = byParent.get(link.waitpointId);
    if (target && bucket) {
      bucket.push(applyProjection(target, projection));
    }
  }
  return byParent;
};

// Snapshots that completed a waitpoint: CompletedWaitpoint join → TaskRunExecutionSnapshot rows.
const hydrateCompletedExecutionSnapshots: DedicatedRelationHydrator = async (
  client,
  parents,
  projection
) =>
  batchHydrateJoinRelation(
    client.completedWaitpoint,
    client.taskRunExecutionSnapshot,
    parents.map((p) => p.id as string),
    "waitpointId",
    "snapshotId",
    projection
  );

// The waitpoint each block edge points at, resolved from its scalar `waitpointId`. The edge's own
// client only finds a co-resident token; the router re-resolves cross-DB.
const hydrateEdgeWaitpoint: DedicatedRelationHydrator = async (client, parents, projection) =>
  batchHydrateEdgeTarget(client.waitpoint, parents, "waitpointId", projection);

// The run each block edge belongs to, resolved from its scalar `taskRunId`.
const hydrateEdgeTaskRun: DedicatedRelationHydrator = async (client, parents, projection) =>
  batchHydrateEdgeTarget(client.taskRun, parents, "taskRunId", projection);

// Generic to-one relation reached via a scalar FK ON the parent itself (not a join model): one
// grouped target query for every distinct FK value across the batch.
async function batchHydrateEdgeTarget(
  targetDelegate: RunOpsDelegate<"findMany">,
  parents: Record<string, unknown>[],
  fkField: string,
  projection: { select?: any; include?: any } | undefined
): Promise<Map<string, unknown>> {
  const byParent = new Map<string, unknown>();
  const targetIds: string[] = [];
  for (const p of parents) {
    byParent.set(p.id as string, null);
    const fk = p[fkField] as string | undefined;
    if (fk) targetIds.push(fk);
  }
  if (targetIds.length === 0) {
    return byParent;
  }
  const rows = (await targetDelegate.findMany(
    targetFindManyArgs({ id: { in: [...new Set(targetIds)] } }, projection, ["id"])
  )) as Record<string, unknown>[];
  const byTargetId = new Map(rows.map((r) => [r.id as string, r]));
  for (const p of parents) {
    const fk = p[fkField] as string | undefined;
    if (fk) {
      byParent.set(p.id as string, applyProjection(byTargetId.get(fk) ?? null, projection));
    }
  }
  return byParent;
}

const TASK_RUN_DEDICATED: DedicatedRelationSpec = {
  associatedWaitpoint: hydrateAssociatedWaitpoint,
  connectedWaitpoints: hydrateConnectedWaitpoints,
};

// Dedicated-schema relations on the TaskRunWaitpoint (block edge) model. The dedicated subset has only the
// scalar `waitpointId`/`taskRunId`, so a caller `select`/`include` naming these relations must be
// stripped and hydrated.
const TASK_RUN_WAITPOINT_DEDICATED: DedicatedRelationSpec = {
  waitpoint: hydrateEdgeWaitpoint,
  taskRun: hydrateEdgeTaskRun,
};

const SNAPSHOT_DEDICATED: DedicatedRelationSpec = {
  completedWaitpoints: hydrateCompletedWaitpoints,
};

const WAITPOINT_DEDICATED: DedicatedRelationSpec = {
  blockingTaskRuns: hydrateBlockingTaskRuns,
  connectedRuns: hydrateConnectedRuns,
  completedExecutionSnapshots: hydrateCompletedExecutionSnapshots,
};

// Cross-generation Prisma error normalization.
//
// The store can be backed by the control-plane `@trigger.dev/database` client OR the
// run-ops `@internal/run-ops-database` client. Each is a SEPARATELY generated client with
// its own copy of the Prisma runtime, so each has its OWN `PrismaClientKnownRequestError`
// class object (identical code, distinct module identity). A P2002 from the run-ops client
// is therefore NOT `instanceof` the control-plane class — so the webapp's uniform
// `error instanceof Prisma.PrismaClientKnownRequestError` P2002→422 conversion is skipped and
// a raw 500 escapes. The store normalizes at its write boundary: any foreign
// known-request-error is re-thrown as the control-plane class so every routed-write caller's
// `instanceof` works regardless of which client raised it.

// `instanceof` can't detect a foreign generation's class, so key on the runtime `name` the
// Prisma runtime stamps on every generation plus a string `code` (the P-code).
function isForeignPrismaKnownRequestError(error: unknown): error is {
  name: string;
  message: string;
  code: string;
  meta?: unknown;
  clientVersion?: string;
} {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "PrismaClientKnownRequestError" &&
    typeof (error as { code?: unknown }).code === "string" &&
    !(error instanceof Prisma.PrismaClientKnownRequestError)
  );
}

// Native + non-known-request errors are returned unchanged (caller re-throws the result).
function normalizeRunOpsError(error: unknown): unknown {
  if (!isForeignPrismaKnownRequestError(error)) {
    return error;
  }
  return new Prisma.PrismaClientKnownRequestError(error.message, {
    code: error.code,
    clientVersion: error.clientVersion ?? "unknown",
    meta: error.meta as Record<string, unknown> | undefined,
  });
}

// Only these Prisma-model delegates carry the create/update/upsert writes that raise P2002;
// `$queryRaw`/`$executeRaw`/`$transaction` are left untouched (raw queries here never raise a
// duplicate-key, and wrapping their tagged-template/callback contract would break it).
const RUN_OPS_DELEGATE_KEYS: ReadonlySet<string> = new Set([
  "taskRun",
  "taskRunAttempt",
  "taskRunExecutionSnapshot",
  "taskRunWaitpoint",
  "taskRunCheckpoint",
  "checkpoint",
  "checkpointRestoreEvent",
  "taskRunDependency",
  "waitpoint",
  "completedWaitpoint",
  "waitpointRunConnection",
  "batchTaskRun",
  "batchTaskRunItem",
  "waitpointTag",
]);

// Every method call on a delegate rewrites ONLY its rejection reason; success is untouched.
function wrapDelegateForErrorNormalization<D extends object>(delegate: D): D {
  return new Proxy(delegate, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        let result: unknown;
        try {
          result = (value as (...a: unknown[]) => unknown).apply(target, args);
        } catch (error) {
          throw normalizeRunOpsError(error);
        }
        // Delegate methods return a thenable PrismaPromise; rewrite its rejection only.
        if (result != null && typeof (result as { then?: unknown }).then === "function") {
          return (result as Promise<unknown>).then(undefined, (error) => {
            throw normalizeRunOpsError(error);
          });
        }
        return result;
      };
    },
  });
}

// Model delegates are wrapped; `$transaction` wraps its tx client so inner writes normalize
// too; every other property (incl. `$queryRaw`/`$executeRaw`) passes through unchanged.
export function wrapRunOpsClientForErrorNormalization<C extends RunOpsCapableClient>(client: C): C {
  // Some tests inject a non-object fake (or nothing) as the client; only a real client can be
  // proxied, and only a real client raises the foreign known-request-errors we normalize.
  if (client == null || (typeof client !== "object" && typeof client !== "function")) {
    return client;
  }
  const delegateCache = new Map<string, unknown>();
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && RUN_OPS_DELEGATE_KEYS.has(prop)) {
        const cached = delegateCache.get(prop);
        if (cached) {
          return cached;
        }
        const delegate = Reflect.get(target, prop, receiver);
        if (delegate == null || typeof delegate !== "object") {
          return delegate;
        }
        const wrapped = wrapDelegateForErrorNormalization(delegate as object);
        delegateCache.set(prop, wrapped);
        return wrapped;
      }

      if (prop === "$transaction") {
        const original = Reflect.get(target, prop, receiver);
        if (typeof original !== "function") {
          return original;
        }
        return (fnOrArray: unknown, ...rest: unknown[]) => {
          // Interactive (callback) form: wrap the tx client so inner writes normalize too.
          if (typeof fnOrArray === "function") {
            const wrappedFn = (tx: RunOpsCapableClient) =>
              (fnOrArray as (t: RunOpsCapableClient) => unknown)(
                wrapRunOpsClientForErrorNormalization(tx)
              );
            return (original as (...a: unknown[]) => unknown).call(target, wrappedFn, ...rest);
          }
          return (original as (...a: unknown[]) => unknown).call(target, fnOrArray, ...rest);
        };
      }

      return Reflect.get(target, prop, receiver);
    },
  }) as C;
}

/**
 * Typed write layer for the task-run row, backed by the `taskRun` Prisma model.
 *
 * Each method is a verbatim relocation of the Prisma statement that lives at a
 * specific call site today. Methods write through `(tx ?? this.prisma).taskRun`
 * so callers can opt into an existing transaction. Errors surface with unique
 * constraint violations (P2002 etc.) normalized to the control-plane
 * `Prisma.PrismaClientKnownRequestError` class (see `wrapRunOpsClientForErrorNormalization`),
 * so `instanceof Prisma.PrismaClientKnownRequestError` works regardless of which
 * generated client backs the store.
 */
// Relations present on the full control-plane schema but ABSENT from the dedicated run-ops subset;
// selecting one against the dedicated client throws an opaque Prisma error for NEW-resident data.
const BATCH_TASK_RUN_CONTROL_PLANE_RELATIONS = ["runsBlocked", "waitpoints", "runtimeEnvironment"];
const TASK_RUN_ATTEMPT_CONTROL_PLANE_RELATIONS = [
  "backgroundWorker",
  "backgroundWorkerTask",
  "runtimeEnvironment",
  "queue",
];

export class PostgresRunStore implements RunStore {
  private readonly prisma: RunOpsCapableClient;
  private readonly readOnlyPrisma: RunOpsCapableClient;
  private readonly schemaVariant: RunStoreSchemaVariant;

  constructor(options: PostgresRunStoreOptions) {
    // Normalize foreign (run-ops-generation) Prisma known-request-errors to the control-plane
    // class at the write boundary so callers' `instanceof Prisma.PrismaClientKnownRequestError`
    // (P2002→422) works regardless of which generated client backs the store.
    this.prisma = wrapRunOpsClientForErrorNormalization(options.prisma);
    this.readOnlyPrisma = wrapRunOpsClientForErrorNormalization(options.readOnlyPrisma);
    this.schemaVariant = options.schemaVariant ?? "legacy";
  }

  // The writer handle in read-client form, so the routing layer can honor a caller-passed client
  // (read-your-writes) with THIS store's own primary instead of leaking the caller's client across
  // DBs. Cast mirrors runInTransaction: the generated clients differ only in delegates reads use.
  get primaryReadClient(): ReadClient {
    return this.prisma as unknown as ReadClient;
  }

  // Open ONE interactive transaction on this store's OWN writer client and run `fn` against THIS store
  // (so subclass overrides survive) with the tx as the client to thread into the inner writes. `runId`
  // is ignored here — a single store has one connection — but is in the contract so the router can
  // resolve the owner. Only the writer opens transactions; the replica has no `$transaction`.
  async runInTransaction<R>(
    _runId: string | undefined,
    fn: (store: RunStore, tx: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    return (this.prisma as RunOpsTransactionalClient).$transaction((tx) =>
      fn(this, tx as unknown as PrismaClientOrTransaction)
    );
  }

  // Run `fn` atomically: reuse the caller's interactive transaction if it gave us a real one, else open
  // our own on this store's writer. A real interactive tx has no `$transaction` method; a base client
  // (which callers, e.g. the engine's dequeue/resume paths, thread through for routing) DOES - so a base
  // client still gets a fresh transaction. Used by write methods that create a row plus dependent rows
  // (snapshot + completed-waitpoints, run + associated-waitpoint) which must commit together.
  #withOptionalTransaction<R>(
    tx: PrismaClientOrTransaction | undefined,
    fn: (client: PrismaClientOrTransaction) => Promise<R>
  ): Promise<R> {
    const alreadyInTransaction =
      tx !== undefined && typeof (tx as { $transaction?: unknown }).$transaction !== "function";
    if (alreadyInTransaction) {
      return fn(tx);
    }
    return (this.prisma as RunOpsTransactionalClient).$transaction((t) =>
      fn(t as unknown as PrismaClientOrTransaction)
    );
  }

  async createRun(
    params: CreateRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const client = tx ?? this.prisma;

    const snapshotCreate = {
      engine: params.snapshot.engine,
      executionStatus: params.snapshot.executionStatus,
      description: params.snapshot.description,
      runStatus: params.snapshot.runStatus,
      environmentId: params.snapshot.environmentId,
      environmentType: params.snapshot.environmentType,
      projectId: params.snapshot.projectId,
      organizationId: params.snapshot.organizationId,
      workerId: params.snapshot.workerId,
      runnerId: params.snapshot.runnerId,
    };

    if (this.schemaVariant === "dedicated") {
      // The run + its associated RUN-type waitpoint are two writes here (the legacy branch below nests
      // them). Commit them together so a crash / lagging read never leaves a run without its waitpoint.
      return this.#withOptionalTransaction(tx, async (c) => {
        const run = (await c.taskRun.create({
          data: {
            ...params.data,
            executionSnapshots: { create: snapshotCreate },
          },
        })) as TaskRun;

        const associatedWaitpoint = await this.#createAssociatedWaitpoint(c, run.id, params);
        return { ...run, associatedWaitpoint };
      });
    }

    return client.taskRun.create({
      include: {
        associatedWaitpoint: true,
      },
      data: {
        ...params.data,
        executionSnapshots: {
          create: snapshotCreate,
        },
        associatedWaitpoint: params.associatedWaitpoint
          ? {
              create: params.associatedWaitpoint,
            }
          : undefined,
      },
    });
  }

  /**
   * Dedicated-schema replacement for the legacy `associatedWaitpoint: { create }` nested write.
   * On the subset schema the association is the scalar `Waitpoint.completedByTaskRunId`, so the
   * RUN-type waitpoint is created as its own row pointing back at the run, then returned so the
   * caller can hydrate the same `{ run, associatedWaitpoint }` contract the legacy include gives.
   */
  async #createAssociatedWaitpoint(
    client: RunOpsCapableClient,
    runId: string,
    params: CreateRunInput | CreateFailedRunInput
  ): Promise<TaskRunWithWaitpoint["associatedWaitpoint"]> {
    if (!params.associatedWaitpoint) {
      return null;
    }

    return (await client.waitpoint.create({
      data: {
        ...params.associatedWaitpoint,
        completedByTaskRunId: runId,
      },
    })) as TaskRunWithWaitpoint["associatedWaitpoint"];
  }

  async createCancelledRun(
    params: CreateCancelledRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const client = tx ?? this.prisma;

    return client.taskRun.create({
      data: {
        ...params.data,
        executionSnapshots: {
          create: {
            engine: params.snapshot.engine,
            executionStatus: params.snapshot.executionStatus,
            description: params.snapshot.description,
            runStatus: params.snapshot.runStatus,
            environmentId: params.snapshot.environmentId,
            environmentType: params.snapshot.environmentType,
            projectId: params.snapshot.projectId,
            organizationId: params.snapshot.organizationId,
            workerId: params.snapshot.workerId,
            runnerId: params.snapshot.runnerId,
          },
        },
      },
    });
  }

  async createFailedRun(
    params: CreateFailedRunInput,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const client = tx ?? this.prisma;

    if (this.schemaVariant === "dedicated") {
      // Run + associated RUN-type waitpoint are two writes here; commit them together (see createRun).
      return this.#withOptionalTransaction(tx, async (c) => {
        const run = (await c.taskRun.create({
          data: { ...params.data },
        })) as TaskRun;

        const associatedWaitpoint = await this.#createAssociatedWaitpoint(c, run.id, params);
        return { ...run, associatedWaitpoint };
      });
    }

    return client.taskRun.create({
      include: {
        associatedWaitpoint: true,
      },
      data: {
        ...params.data,
        associatedWaitpoint: params.associatedWaitpoint
          ? {
              create: params.associatedWaitpoint,
            }
          : undefined,
      },
    });
  }

  async startAttempt<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { attemptNumber: number; executedAt?: Date; isWarmStart: boolean },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        status: "EXECUTING",
        attemptNumber: data.attemptNumber,
        executedAt: data.executedAt,
        isWarmStart: data.isWarmStart,
      },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
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
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        status: "COMPLETED_SUCCESSFULLY",
        completedAt: data.completedAt,
        output: data.output,
        outputType: data.outputType,
        usageDurationMs: data.usageDurationMs,
        costInCents: data.costInCents,
        executionSnapshots: {
          create: {
            executionStatus: data.snapshot.executionStatus,
            description: data.snapshot.description,
            runStatus: data.snapshot.runStatus,
            attemptNumber: data.snapshot.attemptNumber,
            environmentId: data.snapshot.environmentId,
            environmentType: data.snapshot.environmentType,
            projectId: data.snapshot.projectId,
            organizationId: data.snapshot.organizationId,
            workerId: data.snapshot.workerId,
            runnerId: data.snapshot.runnerId,
          },
        },
      },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async recordRetryOutcome<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { machinePreset?: string; usageDurationMs: number; costInCents: number },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        machinePreset: data.machinePreset,
        usageDurationMs: data.usageDurationMs,
        costInCents: data.costInCents,
      },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async requeueRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      { status: "PENDING" },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async recordBulkActionMembership(
    runId: string,
    bulkActionId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    const prisma = tx ?? this.prisma;

    await prisma.taskRun.update({
      where: { id: runId },
      data: {
        bulkActionGroupIds: {
          push: bulkActionId,
        },
      },
    });
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
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        status: "CANCELED",
        ...(data.completedAt !== undefined && { completedAt: data.completedAt }),
        error: data.error as Prisma.InputJsonValue,
        ...(data.bulkActionId !== undefined && {
          bulkActionGroupIds: { push: data.bulkActionId },
        }),
        ...(data.usageDurationMs !== undefined && { usageDurationMs: data.usageDurationMs }),
        ...(data.costInCents !== undefined && { costInCents: data.costInCents }),
      },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
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
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        status: data.status,
        completedAt: data.completedAt,
        error: data.error as Prisma.InputJsonValue,
        usageDurationMs: data.usageDurationMs,
        costInCents: data.costInCents,
      },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  finalizeRun<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: FinalizeRunData,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  finalizeRun<I extends Prisma.TaskRunInclude>(
    runId: string,
    data: FinalizeRunData,
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  finalizeRun(
    runId: string,
    data: FinalizeRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun>;
  async finalizeRun(
    runId: string,
    data: FinalizeRunData,
    argsOrTx?:
      | { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude }
      | PrismaClientOrTransaction,
    tx?: PrismaClientOrTransaction
  ): Promise<unknown> {
    // Disambiguate the 3rd positional: a `{ select | include }` projection vs. a tx client (a client
    // never carries a select/include own-key), mirroring #resolveReadArgs on the read path.
    const isProjection =
      typeof argsOrTx === "object" &&
      argsOrTx !== null &&
      ("select" in argsOrTx || "include" in argsOrTx);
    const args = isProjection
      ? (argsOrTx as { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude })
      : {};
    const prisma =
      (isProjection ? tx : (argsOrTx as PrismaClientOrTransaction | undefined)) ?? this.prisma;

    // status + error land in the SAME update (a separate later error write races realtime, which
    // shuts the stream on the final status before the error lands). undefined fields are skipped.
    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        ...(data.status !== undefined && { status: data.status }),
        ...(data.expiredAt !== undefined && { expiredAt: data.expiredAt }),
        ...(data.completedAt !== undefined && { completedAt: data.completedAt }),
        ...(data.error !== undefined && { error: data.error as Prisma.InputJsonValue }),
        ...(data.bulkActionId !== undefined && {
          bulkActionGroupIds: { push: data.bulkActionId },
        }),
      },
      args
    );
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
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        status: "EXPIRED",
        completedAt: data.completedAt,
        expiredAt: data.expiredAt,
        error: data.error as Prisma.InputJsonValue,
        executionSnapshots: {
          create: {
            engine: data.snapshot.engine,
            executionStatus: data.snapshot.executionStatus,
            description: data.snapshot.description,
            runStatus: data.snapshot.runStatus,
            environmentId: data.snapshot.environmentId,
            environmentType: data.snapshot.environmentType,
            projectId: data.snapshot.projectId,
            organizationId: data.snapshot.organizationId,
          },
        },
      },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async expireRunsBatch(
    runIds: string[],
    data: { error: TaskRunError; now: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<number> {
    const prisma = tx ?? this.prisma;

    // Nothing to do for an empty set, and Prisma.join would build an invalid
    // `IN ()` clause, so short-circuit before touching the database.
    if (runIds.length === 0) {
      return 0;
    }

    // Dedicated: the run-ops generated client binds a bare value array ambiguously (jsonb), so we
    // pass the id list as a single `text[]` param and match with `= ANY`, mirroring blockRunWithWaitpointEdges.
    if (this.schemaVariant === "dedicated") {
      const ids = runIds;
      return prisma.$executeRaw`
        UPDATE "TaskRun"
        SET "status" = 'EXPIRED'::"TaskRunStatus",
            "completedAt" = ${data.now},
            "expiredAt" = ${data.now},
            "updatedAt" = ${data.now},
            "error" = ${JSON.stringify(data.error)}::jsonb
        WHERE "id" = ANY(${ids}::text[])
      `;
    }

    return prisma.$executeRaw`
      UPDATE "TaskRun"
      SET "status" = 'EXPIRED'::"TaskRunStatus",
          "completedAt" = ${data.now},
          "expiredAt" = ${data.now},
          "updatedAt" = ${data.now},
          "error" = ${JSON.stringify(data.error)}::jsonb
      WHERE "id" IN (${Prisma.join(runIds)})
    `;
  }

  /**
   * Dedicated-schema replacement for the legacy `completedWaitpoints: { connect }` nested write.
   * On the subset schema the snapshot↔waitpoint links live in the explicit FK-free
   * `CompletedWaitpoint` join model, so we insert `{ snapshotId, waitpointId }` rows directly.
   */
  async #connectCompletedWaitpoints(
    client: RunOpsCapableClient,
    snapshotId: string,
    waitpointIds: string[]
  ): Promise<void> {
    if (waitpointIds.length === 0 || !client.completedWaitpoint) {
      return;
    }

    await client.completedWaitpoint.createMany({
      data: waitpointIds.map((waitpointId) => ({ snapshotId, waitpointId })),
      skipDuplicates: true,
    });
  }

  // Legacy implicit M2M equivalent of #connectCompletedWaitpoints: raw-insert the join rows FK-free.
  // Prisma `connect` ORM-validates the Waitpoint exists locally, which fails for a cross-DB
  // (NEW-resident) token; the raw insert + dropped _completedWaitpoints_B_fkey records it. A =
  // TaskRunExecutionSnapshot.id, B = Waitpoint.id (implicit M2M alphabetical order).
  async #connectCompletedWaitpointsLegacy(
    client: RunOpsCapableClient,
    snapshotId: string,
    waitpointIds: string[]
  ): Promise<void> {
    if (waitpointIds.length === 0) {
      return;
    }

    await client.$executeRaw`
      INSERT INTO "_completedWaitpoints" ("A", "B")
      SELECT ${snapshotId}, w.id
      FROM unnest(${waitpointIds}::text[]) AS w(id)
      ON CONFLICT DO NOTHING`;
  }

  async lockRunToWorker(
    runId: string,
    data: LockRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>> {
    // The run-lock update (with its nested PENDING_EXECUTING snapshot) and the completed-waitpoint
    // connect must commit together, or a replica-served resume read can see the snapshot without its
    // links and drop the resume.
    return this.#withOptionalTransaction(tx, (c) => this.#lockRunToWorker(runId, data, c));
  }

  async #lockRunToWorker(
    runId: string,
    data: LockRunData,
    prisma: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{}>> {
    const dedicated = this.schemaVariant === "dedicated";

    const result = await prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: "DEQUEUED",
        lockedAt: data.lockedAt,
        lockedById: data.lockedById,
        lockedToVersionId: data.lockedToVersionId,
        lockedQueueId: data.lockedQueueId,
        lockedRetryConfig: data.lockedRetryConfig ?? undefined,
        startedAt: data.startedAt,
        baseCostInCents: data.baseCostInCents,
        machinePreset: data.machinePreset,
        taskVersion: data.taskVersion,
        sdkVersion: data.sdkVersion ?? undefined,
        cliVersion: data.cliVersion ?? undefined,
        maxDurationInSeconds: data.maxDurationInSeconds ?? undefined,
        maxAttempts: data.maxAttempts ?? undefined,
        executionSnapshots: {
          create: {
            id: data.snapshot.id,
            engine: "V2",
            executionStatus: "PENDING_EXECUTING",
            description: "Run was dequeued for execution",
            runStatus: "PENDING",
            attemptNumber: data.snapshot.attemptNumber ?? undefined,
            previousSnapshotId: data.snapshot.previousSnapshotId,
            environmentId: data.snapshot.environmentId,
            environmentType: data.snapshot.environmentType,
            projectId: data.snapshot.projectId,
            organizationId: data.snapshot.organizationId,
            checkpointId: data.snapshot.checkpointId ?? undefined,
            batchId: data.snapshot.batchId ?? undefined,
            // Completed-waitpoint links are inserted FK-free after create (below) for BOTH schemas.
            completedWaitpointOrder: data.snapshot.completedWaitpointOrder,
            workerId: data.snapshot.workerId ?? undefined,
            runnerId: data.snapshot.runnerId ?? undefined,
          },
        },
      },
    });

    if (dedicated) {
      await this.#connectCompletedWaitpoints(
        prisma,
        data.snapshot.id,
        data.snapshot.completedWaitpointIds
      );
    } else {
      await this.#connectCompletedWaitpointsLegacy(
        prisma,
        data.snapshot.id,
        data.snapshot.completedWaitpointIds
      );
    }

    return result;
  }

  async parkPendingVersion<S extends Prisma.TaskRunSelect>(
    runId: string,
    data: { statusReason: string },
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      {
        status: "PENDING_VERSION",
        statusReason: data.statusReason,
      },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async promotePendingVersionRuns(
    runId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    const prisma = tx ?? this.prisma;

    const result = await prisma.taskRun.updateMany({
      where: { id: runId, status: "PENDING_VERSION" },
      data: { status: "PENDING" },
    });

    return { count: result.count };
  }

  async suspendForCheckpoint<I extends Prisma.TaskRunInclude>(
    runId: string,
    args: { include: I },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }>> {
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      { status: "WAITING_TO_RESUME" },
      { include: args.include }
    ) as Promise<Prisma.TaskRunGetPayload<{ include: I }>>;
  }

  async resumeFromCheckpoint<S extends Prisma.TaskRunSelect>(
    runId: string,
    args: { select: S },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return this.#updateTaskRunWithSelect(
      prisma,
      { id: runId },
      { status: "EXECUTING" },
      { select: args.select }
    ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>>;
  }

  async rescheduleRun(
    runId: string,
    data: { delayUntil: Date; queueTimestamp?: Date; snapshot?: RescheduleSnapshotInput },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: {
        delayUntil: data.delayUntil,
        ...(data.queueTimestamp !== undefined && { queueTimestamp: data.queueTimestamp }),
        ...(data.snapshot && {
          executionSnapshots: {
            create: {
              engine: "V2",
              executionStatus: "DELAYED",
              description: "Delayed run was rescheduled to a future date",
              runStatus: "DELAYED",
              environmentId: data.snapshot.environmentId,
              environmentType: data.snapshot.environmentType,
              projectId: data.snapshot.projectId,
              organizationId: data.snapshot.organizationId,
            },
          },
        }),
      },
    });
  }

  async enqueueDelayedRun(
    runId: string,
    data: { queuedAt: Date },
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRun> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId },
      data: {
        status: "PENDING",
        queuedAt: data.queuedAt,
      },
    });
  }

  async rewriteDebouncedRun(
    runId: string,
    data: RewriteDebouncedRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<TaskRunWithWaitpoint> {
    const prisma = tx ?? this.prisma;

    if (this.schemaVariant === "dedicated") {
      const run = (await prisma.taskRun.update({ where: { id: runId }, data })) as TaskRun;
      const associatedWaitpoint = await this.#findAssociatedWaitpoint(prisma, runId);
      return { ...run, associatedWaitpoint };
    }

    return prisma.taskRun.update({
      where: { id: runId },
      data,
      include: {
        associatedWaitpoint: true,
      },
    });
  }

  /**
   * Dedicated-schema replacement for the legacy `include: { associatedWaitpoint: true }` run read.
   * The relation doesn't exist on the subset schema; the RUN-type waitpoint is found by its scalar
   * `completedByTaskRunId` back-pointer (`@unique`), so at most one matches.
   */
  async #findAssociatedWaitpoint(
    client: RunOpsCapableClient,
    runId: string
  ): Promise<TaskRunWithWaitpoint["associatedWaitpoint"]> {
    return (await client.waitpoint.findFirst({
      where: { completedByTaskRunId: runId },
    })) as TaskRunWithWaitpoint["associatedWaitpoint"];
  }

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
    const prisma = tx ?? this.prisma;

    if (options.expectedMetadataVersion !== undefined) {
      const result = await prisma.taskRun.updateMany({
        where: { id: runId, metadataVersion: options.expectedMetadataVersion },
        data,
      });
      return { count: result.count };
    }

    await prisma.taskRun.update({
      where: { id: runId },
      data,
    });
    return { count: 1 };
  }

  async clearIdempotencyKey(
    params: ClearIdempotencyKeyInput,
    tx?: PrismaClientOrTransaction
  ): Promise<{ count: number }> {
    const prisma = tx ?? this.prisma;

    if (params.byId) {
      const result = await prisma.taskRun.updateMany({
        where: { id: params.byId.runId, idempotencyKey: params.byId.idempotencyKey },
        data: { idempotencyKey: null, idempotencyKeyExpiresAt: null },
      });
      return { count: result.count };
    }

    if (params.byPredicate) {
      const result = await prisma.taskRun.updateMany({
        where: {
          idempotencyKey: params.byPredicate.idempotencyKey,
          taskIdentifier: params.byPredicate.taskIdentifier,
          runtimeEnvironmentId: params.byPredicate.runtimeEnvironmentId,
        },
        data: { idempotencyKey: null, idempotencyKeyExpiresAt: null },
      });
      return { count: result.count };
    }

    // byFriendlyIds — only clears idempotencyKey, not idempotencyKeyExpiresAt
    const result = await prisma.taskRun.updateMany({
      where: { friendlyId: { in: params.byFriendlyIds } },
      data: { idempotencyKey: null },
    });
    return { count: result.count };
  }

  async createBatchTaskRunItem(
    data: { batchTaskRunId: string; taskRunId: string; status: BatchTaskRunItemStatus },
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    const prisma = tx ?? this.prisma;

    await prisma.batchTaskRunItem.create({ data });
  }

  async pushTags(
    runId: string,
    tags: string[],
    where: { runtimeEnvironmentId: string },
    tx?: PrismaClientOrTransaction
  ): Promise<{ updatedAt: Date }> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRun.update({
      where: { id: runId, runtimeEnvironmentId: where.runtimeEnvironmentId },
      data: { runTags: { push: tags } },
      select: { updatedAt: true },
    });
  }

  async pushRealtimeStream(
    runId: string,
    streamId: string,
    tx?: PrismaClientOrTransaction
  ): Promise<void> {
    const prisma = tx ?? this.prisma;

    await prisma.taskRun.update({
      where: { id: runId },
      data: { realtimeStreams: { push: streamId } },
    });
  }

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
  async findRun(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | ReadClient,
    client?: ReadClient
  ): Promise<unknown> {
    const { args, prisma } = this.#resolveReadArgs(argsOrClient, client);

    return this.#findTaskRunWithSelect(prisma, "findFirst", where, args);
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
  async findRunOrThrow(
    where: Prisma.TaskRunWhereInput,
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | ReadClient,
    client?: ReadClient
  ): Promise<unknown> {
    const { args, prisma } = this.#resolveReadArgs(argsOrClient, client);

    return this.#findTaskRunWithSelect(prisma, "findFirstOrThrow", where, args);
  }

  // Read-after-write on THIS store's PRIMARY (writer), never the replica. Mirrors
  // `findWaitpointOnPrimary`: a caller that just wrote a run in this request re-reads it here so
  // replica lag can't null out a fresh row and turn a successful create into a false "not found".
  // The routing store dispatches here (per owning store) when the caller passed the control-plane
  // writer, so each store reads its OWN writer and never leaks a control-plane client into another DB.
  findRunOnPrimary<S extends Prisma.TaskRunSelect>(
    where: Prisma.TaskRunWhereInput,
    args: { select: S }
  ): Promise<Prisma.TaskRunGetPayload<{ select: S }> | null>;
  findRunOnPrimary<I extends Prisma.TaskRunInclude>(
    where: Prisma.TaskRunWhereInput,
    args: { include: I }
  ): Promise<Prisma.TaskRunGetPayload<{ include: I }> | null>;
  findRunOnPrimary(where: Prisma.TaskRunWhereInput): Promise<TaskRun | null>;
  async findRunOnPrimary(
    where: Prisma.TaskRunWhereInput,
    args?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude }
  ): Promise<unknown> {
    return this.#findTaskRunWithSelect(this.prisma, "findFirst", where, args ?? {});
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
  async findRunOrThrowOnPrimary(
    where: Prisma.TaskRunWhereInput,
    args?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude }
  ): Promise<unknown> {
    return this.#findTaskRunWithSelect(this.prisma, "findFirstOrThrow", where, args ?? {});
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
  async findRuns(
    args: {
      where: Prisma.TaskRunWhereInput;
      select?: Prisma.TaskRunSelect;
      include?: Prisma.TaskRunInclude;
      orderBy?: Prisma.TaskRunOrderByWithRelationInput | Prisma.TaskRunOrderByWithRelationInput[];
      take?: number;
      skip?: number;
      cursor?: Prisma.TaskRunWhereUniqueInput;
    },
    client?: ReadClient
  ): Promise<unknown> {
    const prisma = client ?? this.readOnlyPrisma;

    if (this.schemaVariant !== "dedicated" || (!args.select && !args.include)) {
      return prisma.taskRun.findMany(args);
    }

    const { where, orderBy, take, skip, cursor, ...projection } = args;
    const { stripped, requested } = stripDedicatedRelations(projection, TASK_RUN_DEDICATED);
    const rows = (await (prisma as RunOpsCapableClient).taskRun.findMany({
      where,
      orderBy,
      take,
      skip,
      cursor,
      ...stripped,
    })) as Record<string, unknown>[];
    await this.#hydrateDedicatedRelations(
      prisma as RunOpsCapableClient,
      rows,
      requested,
      TASK_RUN_DEDICATED
    );
    return rows;
  }

  // Grouped replacement for `Promise.all(ids.map(id => findRun(id)))`: a thin wrapper over
  // `findRuns` (so it inherits dedicated-relation hydration + read-your-writes client routing),
  // bounding the whole id batch into one round trip instead of one per id.
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
    argsOrClient?: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude } | ReadClient,
    _client?: ReadClient
  ): Promise<Map<string, unknown>> {
    if (ids.length === 0) {
      return new Map();
    }
    const hasSelectOrInclude =
      argsOrClient != null &&
      typeof argsOrClient === "object" &&
      ("select" in argsOrClient || "include" in argsOrClient);
    const args = hasSelectOrInclude
      ? (argsOrClient as { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude })
      : undefined;
    // Slot recovery mirrors `findRuns`'s overloads: when `argsOrClient` isn't a
    // `{ select | include }` object it may itself BE the client (2-arg call) or be undefined
    // with the client in the 3rd slot (an explicit `(ids, undefined, client)` call).
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
      { where: { id: { in: ids } }, ...projected } as Parameters<PostgresRunStore["findRuns"]>[0],
      client
    )) as Record<string, unknown>[];
    const byId = new Map<string, unknown>();
    // Strip the id we force-injected for map keying when the caller's select did not ask for it,
    // so returned values match the declared payload type and never leak an unrequested id.
    const stripInjectedId = args?.select != null && !("id" in args.select);
    for (const row of rows) {
      const key = row.id as string;
      if (stripInjectedId) {
        delete row.id;
      }
      byId.set(key, row);
    }
    return byId;
  }

  async findRunsByIdempotencyKeys(
    args: { runtimeEnvironmentId: string; taskIdentifier: string; idempotencyKeys: string[] },
    client?: ReadClient
  ): Promise<IdempotencyKeyRunMatch[]> {
    if (args.idempotencyKeys.length === 0) {
      return [];
    }
    const prisma = (client ?? this.readOnlyPrisma) as RunOpsCapableClient;
    const params: string[] = [];
    const branches = args.idempotencyKeys.map((key) => {
      const base = params.length;
      params.push(args.runtimeEnvironmentId, args.taskIdentifier, key);
      return `SELECT "friendlyId", "idempotencyKey", "idempotencyKeyExpiresAt" FROM "TaskRun" WHERE "runtimeEnvironmentId" = $${base + 1} AND "taskIdentifier" = $${base + 2} AND "idempotencyKey" = $${base + 3}`;
    });
    return prisma.$queryRawUnsafe<IdempotencyKeyRunMatch[]>(
      branches.join(" UNION ALL "),
      ...params
    );
  }

  // --- run-ops persistence ---

  async findLatestExecutionSnapshot(
    runId: string,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{
    include: { completedWaitpoints: true; checkpoint: true };
  }> | null> {
    const prisma = client ?? this.readOnlyPrisma;

    if (this.schemaVariant === "dedicated") {
      const snapshot = await prisma.taskRunExecutionSnapshot.findFirst({
        where: { runId, isValid: true },
        include: { checkpoint: true },
        orderBy: { createdAt: "desc" },
      });
      if (!snapshot) {
        return null;
      }
      const completedWaitpoints = await this.#hydrateCompletedWaitpoints(prisma, snapshot.id);
      return { ...snapshot, completedWaitpoints };
    }

    return prisma.taskRunExecutionSnapshot.findFirst({
      where: { runId, isValid: true },
      include: {
        completedWaitpoints: true,
        checkpoint: true,
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Dedicated-schema replacement for the legacy `include: { completedWaitpoints: true }` snapshot
   * read. The relation doesn't exist on the subset schema, so we resolve the linked waitpoint ids
   * from the explicit `CompletedWaitpoint` join model and load the rows to fill the same array.
   */
  async #hydrateCompletedWaitpoints(
    client: RunOpsCapableClient,
    snapshotId: string
  ): Promise<unknown[]> {
    if (!client.completedWaitpoint) {
      return [];
    }
    const links = (await client.completedWaitpoint.findMany({
      where: { snapshotId },
      select: { waitpointId: true },
    })) as { waitpointId: string }[];
    if (links.length === 0) {
      return [];
    }
    return client.waitpoint.findMany({
      where: { id: { in: links.map((l) => l.waitpointId) } },
    });
  }

  async findExecutionSnapshot<T extends Prisma.TaskRunExecutionSnapshotFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null> {
    const prisma = client ?? this.readOnlyPrisma;

    if (this.schemaVariant !== "dedicated") {
      return prisma.taskRunExecutionSnapshot.findFirst(
        args
      ) as Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null>;
    }

    const { where, orderBy, take, skip, cursor, ...projection } = args as Record<string, any>;
    return this.#runDedicatedSelect(
      prisma as RunOpsCapableClient,
      (stripped) =>
        (prisma as RunOpsCapableClient).taskRunExecutionSnapshot.findFirst({
          where,
          orderBy,
          take,
          skip,
          cursor,
          ...stripped,
        }),
      projection,
      SNAPSHOT_DEDICATED
    ) as Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T> | null>;
  }

  async findManyExecutionSnapshots<T extends Prisma.TaskRunExecutionSnapshotFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunExecutionSnapshotFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<T>[]> {
    const prisma = client ?? this.readOnlyPrisma;

    if (this.schemaVariant !== "dedicated") {
      return prisma.taskRunExecutionSnapshot.findMany(args) as Promise<
        Prisma.TaskRunExecutionSnapshotGetPayload<T>[]
      >;
    }

    const { where, orderBy, take, skip, cursor, ...projection } = args as Record<string, any>;
    const { stripped, requested } = stripDedicatedRelations(projection, SNAPSHOT_DEDICATED);
    const rows = (await (prisma as RunOpsCapableClient).taskRunExecutionSnapshot.findMany({
      where,
      orderBy,
      take,
      skip,
      cursor,
      ...stripped,
    })) as Record<string, unknown>[];
    await this.#hydrateDedicatedRelations(
      prisma as RunOpsCapableClient,
      rows,
      requested,
      SNAPSHOT_DEDICATED
    );
    return rows as Prisma.TaskRunExecutionSnapshotGetPayload<T>[];
  }

  async createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    // The snapshot row and its completed-waitpoint join rows MUST commit together. `/snapshots/since`
    // can be served from a lagging read replica, so a snapshot that commits before its links can be
    // read back waitpoint-less and the runner's resume is lost (the run hangs). This is the warm-continue
    // path: the engine threads its base prisma through as `tx`, which is not a real transaction.
    return this.#withOptionalTransaction(tx, (c) => this.#createExecutionSnapshot(input, c));
  }

  async #createExecutionSnapshot(
    input: CreateExecutionSnapshotInput,
    prisma: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunExecutionSnapshotGetPayload<{ include: { checkpoint: true } }>> {
    const {
      run,
      snapshot,
      previousSnapshotId,
      batchId,
      environmentId,
      environmentType,
      projectId,
      organizationId,
      checkpointId,
      workerId,
      runnerId,
      completedWaitpoints,
      error,
    } = input;

    const dedicated = this.schemaVariant === "dedicated";

    const newSnapshot = await prisma.taskRunExecutionSnapshot.create({
      data: {
        engine: "V2",
        executionStatus: snapshot.executionStatus,
        description: snapshot.description,
        previousSnapshotId,
        runId: run.id,
        // We can't set the runStatus to DEQUEUED because it will break older runners
        runStatus: run.status === "DEQUEUED" ? "PENDING" : run.status,
        attemptNumber: run.attemptNumber ?? undefined,
        batchId,
        environmentId,
        environmentType,
        projectId,
        organizationId,
        checkpointId,
        workerId,
        runnerId,
        metadata: snapshot.metadata ?? undefined,
        // Completed-waitpoint links are inserted FK-free after create (below) for BOTH schemas, so a
        // cross-DB (NEW-resident) token can be recorded without a Prisma `connect` existence check.
        completedWaitpointOrder: completedWaitpoints
          ?.filter((c) => c.index !== undefined)
          .sort((a, b) => a.index! - b.index!)
          .map((w) => w.id),
        isValid: error ? false : true,
        error,
      },
      include: { checkpoint: true },
    });

    const completedWaitpointIds = completedWaitpoints?.map((w) => w.id) ?? [];
    if (dedicated) {
      await this.#connectCompletedWaitpoints(prisma, newSnapshot.id, completedWaitpointIds);
    } else {
      await this.#connectCompletedWaitpointsLegacy(prisma, newSnapshot.id, completedWaitpointIds);
    }

    return newSnapshot;
  }

  async findSnapshotCompletedWaitpointIds(
    snapshotId: string,
    client?: ReadClient
  ): Promise<string[]> {
    const prisma = client ?? this.readOnlyPrisma;

    // Dedicated: the links live in the explicit CompletedWaitpoint join model; the legacy implicit
    // `_completedWaitpoints` M2M table does not exist on the subset schema. (`ReadClient` does not
    // surface the join delegate; on the dedicated path the read client is always a RunOpsClient.)
    const joinDelegate = (prisma as RunOpsCapableClient).completedWaitpoint;
    if (this.schemaVariant === "dedicated" && joinDelegate) {
      const links = (await joinDelegate.findMany({
        where: { snapshotId },
        select: { waitpointId: true },
      })) as { waitpointId: string }[];
      return links.map((l) => l.waitpointId);
    }

    const result = await prisma.$queryRaw<{ B: string }[]>`
      SELECT "B" FROM "_completedWaitpoints" WHERE "A" = ${snapshotId}
    `;
    return result.map((r) => r.B);
  }

  // One query: LEFT JOIN the snapshot to its completed-waitpoint links so `present` (snapshot visible
  // on this reader) and `ids` come from the SAME point-in-time. A multi-reader replica can otherwise
  // return the snapshot (via a separate read) while a different, laggier reader returns 0 links.
  async findSnapshotCompletedWaitpointIdsWithPresence(
    snapshotId: string,
    client?: ReadClient
  ): Promise<{ present: boolean; ids: string[] }> {
    const prisma = client ?? this.readOnlyPrisma;

    const joinDelegate = (prisma as RunOpsCapableClient).completedWaitpoint;
    if (this.schemaVariant === "dedicated" && joinDelegate) {
      const rows = await prisma.$queryRaw<{ id: string; waitpointId: string | null }[]>`
        SELECT s."id", cw."waitpointId"
        FROM "TaskRunExecutionSnapshot" s
        LEFT JOIN "CompletedWaitpoint" cw ON cw."snapshotId" = s."id"
        WHERE s."id" = ${snapshotId}
      `;
      return {
        present: rows.length > 0,
        ids: rows.filter((r) => r.waitpointId !== null).map((r) => r.waitpointId as string),
      };
    }

    const rows = await prisma.$queryRaw<{ id: string; B: string | null }[]>`
      SELECT s."id", cw."B"
      FROM "TaskRunExecutionSnapshot" s
      LEFT JOIN "_completedWaitpoints" cw ON cw."A" = s."id"
      WHERE s."id" = ${snapshotId}
    `;
    return {
      present: rows.length > 0,
      ids: rows.filter((r) => r.B !== null).map((r) => r.B as string),
    };
  }

  // Reverse of `connectedRuns`: the run ids linked to a waitpoint. Co-resident with the RUN (the join
  // is written on the run's DB in blockRunWithWaitpointEdges), so the waitpoint's own store can MISS a
  // cross-DB run — the router fans this across BOTH DBs.
  // Bounded to CONNECTED_RUNS_LIMIT via an existence-JOIN to TaskRun, mirroring the webapp's
  // `#connectedRunIdsOn`: a dangling connection row (dedicated schema: FK-free `taskRunId`) can
  // never occupy a LIMIT slot ahead of a real run, and a heavily-fanned-in waitpoint can never emit
  // an unbounded id list.
  async findWaitpointConnectedRunIds(waitpointId: string, client?: ReadClient): Promise<string[]> {
    const prisma = client ?? this.readOnlyPrisma;

    const joinDelegate = (prisma as RunOpsCapableClient).waitpointRunConnection;
    if (this.schemaVariant === "dedicated" && joinDelegate) {
      const rows = await prisma.$queryRaw<{ taskRunId: string }[]>`
        SELECT c."taskRunId" AS "taskRunId"
        FROM "WaitpointRunConnection" c
        JOIN "TaskRun" t ON t."id" = c."taskRunId"
        WHERE c."waitpointId" = ${waitpointId}
        LIMIT ${CONNECTED_RUNS_LIMIT}
      `;
      return rows.map((row) => row.taskRunId);
    }

    // Legacy implicit M2M `_WaitpointRunConnections`: A = TaskRun.id, B = Waitpoint.id (alphabetical).
    const rows = await prisma.$queryRaw<{ A: string }[]>`
      SELECT c."A" AS "A"
      FROM "_WaitpointRunConnections" c
      JOIN "TaskRun" t ON t."id" = c."A"
      WHERE c."B" = ${waitpointId}
      LIMIT ${CONNECTED_RUNS_LIMIT}
    `;
    return rows.map((row) => row.A);
  }

  // Reverse of `completedExecutionSnapshots`: the snapshot ids that completed a waitpoint. The join is
  // co-resident with the SNAPSHOT/run, so the waitpoint's own store can MISS a cross-DB snapshot — the
  // router fans this across BOTH DBs (the reverse direction of the resume-payload output recovery).
  async findWaitpointCompletedSnapshotIds(
    waitpointId: string,
    client?: ReadClient
  ): Promise<string[]> {
    const prisma = client ?? this.readOnlyPrisma;

    const joinDelegate = (prisma as RunOpsCapableClient).completedWaitpoint;
    if (this.schemaVariant === "dedicated" && joinDelegate) {
      const links = (await joinDelegate.findMany({
        where: { waitpointId },
        select: { snapshotId: true },
      })) as { snapshotId: string }[];
      return links.map((l) => l.snapshotId);
    }

    // Legacy implicit M2M `_completedWaitpoints`: A = TaskRunExecutionSnapshot.id, B = Waitpoint.id.
    const result = await prisma.$queryRaw<{ A: string }[]>`
      SELECT "A" FROM "_completedWaitpoints" WHERE "B" = ${waitpointId}
    `;
    return result.map((r) => r.A);
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
    const { runId, waitpointIds, projectId, spanIdToComplete, batchId, batchIndex, tx } = params;
    const prisma = tx ?? this.prisma;

    // Nothing to block for an empty set, and Prisma.join would build an invalid `IN ()`
    // clause, so short-circuit before touching the database.
    if (waitpointIds.length === 0) {
      return;
    }

    // Dedicated: the run↔waitpoint connection lives in the explicit FK-free `WaitpointRunConnection`
    // table; the legacy implicit `_WaitpointRunConnections` M2M does not exist on the subset schema.
    if (this.schemaVariant === "dedicated") {
      // Source the edge rows from the waitpointId array DIRECTLY via `unnest`, NOT a join to the local
      // `"Waitpoint"` table: this branch is FK-free, and for the tolerated NEW-run→LEGACY-token
      // direction the token lives on the OTHER DB, so `FROM "Waitpoint" w` would match 0 rows and the
      // run would hang forever. The token's status is resolved at completion by the both-DB fan-out.
      // The run-ops client binds a bare array ambiguously (jsonb), so pass it as one `text[]` param.
      const ids = waitpointIds;
      await prisma.$queryRaw`
        WITH inserted AS (
          INSERT INTO "TaskRunWaitpoint" ("id", "taskRunId", "waitpointId", "projectId", "createdAt", "updatedAt", "spanIdToComplete", "batchId", "batchIndex")
          SELECT
            gen_random_uuid(),
            ${runId},
            w.id,
            ${projectId},
            NOW(),
            NOW(),
            ${spanIdToComplete ?? null}::text,
            ${batchId ?? null}::text,
            ${batchIndex ?? null}::int
          FROM unnest(${ids}::text[]) AS w(id)
          ON CONFLICT DO NOTHING
          RETURNING "waitpointId"
        ),
        connected_runs AS (
          INSERT INTO "WaitpointRunConnection" ("id", "taskRunId", "waitpointId")
          SELECT gen_random_uuid(), ${runId}, w.id
          FROM unnest(${ids}::text[]) AS w(id)
          ON CONFLICT DO NOTHING
        )
        SELECT COUNT(*) FROM inserted`;
      return;
    }

    // Source edges from the id array via `unnest` (like the dedicated branch), NOT `FROM "Waitpoint"`:
    // a cross-DB token (LEGACY run -> NEW-resident token) lives on the other DB, so the join matched 0
    // rows and the run hung. Needs the _WaitpointRunConnections -> Waitpoint FK dropped (migration);
    // casts are required because `unnest` gives no column types for the nullable params.
    const ids = waitpointIds;
    await prisma.$queryRaw`
      WITH inserted AS (
        INSERT INTO "TaskRunWaitpoint" ("id", "taskRunId", "waitpointId", "projectId", "createdAt", "updatedAt", "spanIdToComplete", "batchId", "batchIndex")
        SELECT
          gen_random_uuid(),
          ${runId},
          w.id,
          ${projectId},
          NOW(),
          NOW(),
          ${spanIdToComplete ?? null}::text,
          ${batchId ?? null}::text,
          ${batchIndex ?? null}::int
        FROM unnest(${ids}::text[]) AS w(id)
        ON CONFLICT DO NOTHING
        RETURNING "waitpointId"
      ),
      connected_runs AS (
        INSERT INTO "_WaitpointRunConnections" ("A", "B")
        SELECT ${runId}, w.id
        FROM unnest(${ids}::text[]) AS w(id)
        ON CONFLICT DO NOTHING
      )
      SELECT COUNT(*) FROM inserted`;
  }

  async countPendingWaitpoints(waitpointIds: string[], client?: ReadClient): Promise<number> {
    const prisma = client ?? this.readOnlyPrisma;

    if (waitpointIds.length === 0) {
      return 0;
    }

    // Separate statement from the blocking CTE on purpose: under READ COMMITTED each
    // statement gets its own snapshot, so this fresh query reflects concurrent commits the
    // CTE's snapshot could not see.
    if (this.schemaVariant === "dedicated") {
      // The run-ops generated client binds a bare value array ambiguously (jsonb), so pass the id
      // list as a single text[] param and match with `= ANY`, mirroring blockRunWithWaitpointEdges.
      const pendingCheck = await prisma.$queryRaw<{ pending_count: bigint }[]>`
        SELECT COUNT(*) as pending_count
        FROM "Waitpoint"
        WHERE id = ANY(${waitpointIds}::text[])
        AND status = 'PENDING'
      `;
      return Number(pendingCheck[0]?.pending_count ?? 0);
    }

    const pendingCheck = await prisma.$queryRaw<{ pending_count: bigint }[]>`
      SELECT COUNT(*) as pending_count
      FROM "Waitpoint"
      WHERE id IN (${Prisma.join(waitpointIds)})
      AND status = 'PENDING'
    `;
    return Number(pendingCheck[0]?.pending_count ?? 0);
  }

  async createWaitpoint<T extends Prisma.WaitpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointCreateArgs>,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    const prisma = tx ?? this.prisma;

    return prisma.waitpoint.create(args) as Promise<Prisma.WaitpointGetPayload<T>>;
  }

  async upsertWaitpoint<T extends Prisma.WaitpointUpsertArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpsertArgs>,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    const prisma = tx ?? this.prisma;

    return prisma.waitpoint.upsert(args) as Promise<Prisma.WaitpointGetPayload<T>>;
  }

  async findWaitpoint<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    return this.#findWaitpointOn(client ?? this.readOnlyPrisma, args);
  }

  // Read-after-write on the OWNING store's PRIMARY: the unblock path re-reads a waitpoint it just
  // wrote on the primary, and the replica (findWaitpoint's default) can miss it under replication
  // lag and wrongly throw "not found", stranding the parent run.
  async findWaitpointOnPrimary<T extends Prisma.WaitpointFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    return this.#findWaitpointOn(this.prisma, args);
  }

  #findWaitpointOn<T extends Prisma.WaitpointFindFirstArgs>(
    prisma: ReadClient | RunOpsCapableClient,
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindFirstArgs>
  ): Promise<Prisma.WaitpointGetPayload<T> | null> {
    if (this.schemaVariant !== "dedicated") {
      return prisma.waitpoint.findFirst(args) as Promise<Prisma.WaitpointGetPayload<T> | null>;
    }

    const { where, orderBy, take, skip, cursor, ...projection } = args as Record<string, any>;
    return this.#runDedicatedSelect(
      prisma as RunOpsCapableClient,
      (stripped) =>
        (prisma as RunOpsCapableClient).waitpoint.findFirst({
          where,
          orderBy,
          take,
          skip,
          cursor,
          ...stripped,
        }),
      projection,
      WAITPOINT_DEDICATED
    ) as Promise<Prisma.WaitpointGetPayload<T> | null>;
  }

  async findManyWaitpoints<T extends Prisma.WaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.WaitpointGetPayload<T>[]> {
    const prisma = client ?? this.readOnlyPrisma;

    if (this.schemaVariant !== "dedicated") {
      return prisma.waitpoint.findMany(args) as Promise<Prisma.WaitpointGetPayload<T>[]>;
    }

    const { where, orderBy, take, skip, cursor, ...projection } = args as Record<string, any>;
    const { stripped, requested } = stripDedicatedRelations(projection, WAITPOINT_DEDICATED);
    const rows = (await (prisma as RunOpsCapableClient).waitpoint.findMany({
      where,
      orderBy,
      take,
      skip,
      cursor,
      ...stripped,
    })) as Record<string, unknown>[];
    await this.#hydrateDedicatedRelations(
      prisma as RunOpsCapableClient,
      rows,
      requested,
      WAITPOINT_DEDICATED
    );
    return rows as Prisma.WaitpointGetPayload<T>[];
  }

  async updateWaitpoint<T extends Prisma.WaitpointUpdateArgs>(
    args: Prisma.SelectSubset<T, Prisma.WaitpointUpdateArgs>,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.WaitpointGetPayload<T>> {
    const prisma = tx ?? this.prisma;

    return prisma.waitpoint.update(args) as Promise<Prisma.WaitpointGetPayload<T>>;
  }

  async updateManyWaitpoints(
    args: Prisma.WaitpointUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    const prisma = tx ?? this.prisma;

    return prisma.waitpoint.updateMany(args);
  }

  async forWaitpointCompletion(
    _waitpointId: string,
    _context: ForWaitpointCompletionContext
  ): Promise<RunStore> {
    // Single store: the one store always owns the completion. No classification.
    return this;
  }

  async findManyTaskRunWaitpoints<T extends Prisma.TaskRunWaitpointFindManyArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunWaitpointFindManyArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunWaitpointGetPayload<T>[]> {
    const prisma = client ?? this.readOnlyPrisma;

    if (this.schemaVariant !== "dedicated") {
      return prisma.taskRunWaitpoint.findMany(args) as Promise<
        Prisma.TaskRunWaitpointGetPayload<T>[]
      >;
    }

    // Dedicated subset: strip the `waitpoint`/`taskRun` relation keys (no relation on the subset →
    // straight-through would throw a Prisma validation error), run the scalar findMany, then hydrate
    // from the edge's own client. A cross-DB token is missed here and re-resolved by the router.
    const { where, orderBy, take, skip, cursor, ...projection } = args as Record<string, any>;
    const { stripped, requested } = stripDedicatedRelations(
      projection,
      TASK_RUN_WAITPOINT_DEDICATED
    );
    // Keep the scalar ids the hydrators key off through a narrowed select.
    if (stripped.select) {
      stripped.select.waitpointId = true;
      stripped.select.taskRunId = true;
    }
    const rows = (await (prisma as RunOpsCapableClient).taskRunWaitpoint.findMany({
      where,
      orderBy,
      take,
      skip,
      cursor,
      ...stripped,
    })) as Record<string, unknown>[];
    await this.#hydrateDedicatedRelations(
      prisma as RunOpsCapableClient,
      rows,
      requested,
      TASK_RUN_WAITPOINT_DEDICATED
    );
    return rows as Prisma.TaskRunWaitpointGetPayload<T>[];
  }

  async deleteManyTaskRunWaitpoints(
    args: Prisma.TaskRunWaitpointDeleteManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRunWaitpoint.deleteMany(args);
  }

  // The dedicated subset schema lacks control-plane relations; a pass-through include/select of one
  // throws an opaque Prisma "Unknown field" 500 for NEW-resident data - invisible to tsc, since the
  // run-ops client is typed as the full schema. Reject the known control-plane-only keys with a clear
  // message at the boundary. No-op on the legacy (full-schema) store.
  #assertSubsetSelectable(
    fields: Record<string, unknown> | null | undefined,
    forbidden: readonly string[],
    method: string
  ): void {
    if (this.schemaVariant !== "dedicated" || !fields) return;
    for (const key of forbidden) {
      if (fields[key]) {
        throw new Error(
          `${method}: "${key}" is not available on the dedicated run-ops subset schema ` +
            `(control-plane-only); resolve it via the control-plane instead of selecting it here.`
        );
      }
    }
  }

  async findTaskRunAttempt<T extends Prisma.TaskRunAttemptFindFirstArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunAttemptFindFirstArgs>,
    client?: ReadClient
  ): Promise<Prisma.TaskRunAttemptGetPayload<T> | null> {
    const prisma = client ?? this.readOnlyPrisma;

    const forbidden = TASK_RUN_ATTEMPT_CONTROL_PLANE_RELATIONS;
    this.#assertSubsetSelectable(
      (args as { include?: Record<string, unknown> }).include,
      forbidden,
      "findTaskRunAttempt"
    );
    this.#assertSubsetSelectable(
      (args as { select?: Record<string, unknown> }).select,
      forbidden,
      "findTaskRunAttempt"
    );

    return prisma.taskRunAttempt.findFirst(
      args
    ) as Promise<Prisma.TaskRunAttemptGetPayload<T> | null>;
  }

  async createTaskRunCheckpoint<T extends Prisma.TaskRunCheckpointCreateArgs>(
    args: Prisma.SelectSubset<T, Prisma.TaskRunCheckpointCreateArgs>,
    // `ownerRunId` selects the residency at the router; a single store has one client and ignores it.
    _ownerRunId?: string,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.TaskRunCheckpointGetPayload<T>> {
    const prisma = tx ?? this.prisma;

    return prisma.taskRunCheckpoint.create(args) as Promise<Prisma.TaskRunCheckpointGetPayload<T>>;
  }

  // --- BatchTaskRun (run-ops) ---

  async createBatchTaskRun(
    data: CreateBatchTaskRunData,
    tx?: PrismaClientOrTransaction
  ): Promise<BatchTaskRun> {
    const prisma = tx ?? this.prisma;

    return prisma.batchTaskRun.create({ data });
  }

  async updateBatchTaskRun<S extends Prisma.BatchTaskRunSelect>(
    args: {
      where: Prisma.BatchTaskRunWhereUniqueInput;
      data: Prisma.BatchTaskRunUpdateInput;
      select: S;
    },
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchTaskRunGetPayload<{ select: S }>> {
    const prisma = tx ?? this.prisma;

    return prisma.batchTaskRun.update(args) as Promise<
      Prisma.BatchTaskRunGetPayload<{ select: S }>
    >;
  }

  // Defaults to the primary: the worker reads the just-written batch row and replica
  // lag would break it.
  async findBatchTaskRunById<T extends Prisma.BatchTaskRunInclude = {}>(
    id: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    const prisma = client ?? this.prisma;

    this.#assertSubsetSelectable(
      args?.include as Record<string, unknown> | undefined,
      BATCH_TASK_RUN_CONTROL_PLANE_RELATIONS,
      "findBatchTaskRunById"
    );

    return prisma.batchTaskRun.findFirst({
      where: { id },
      ...(args?.include ? { include: args.include } : {}),
    }) as Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null>;
  }

  async findBatchTaskRunByFriendlyId<T extends Prisma.BatchTaskRunInclude = {}>(
    friendlyId: string,
    environmentId: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    const prisma = client ?? this.readOnlyPrisma;

    this.#assertSubsetSelectable(
      args?.include as Record<string, unknown> | undefined,
      BATCH_TASK_RUN_CONTROL_PLANE_RELATIONS,
      "findBatchTaskRunByFriendlyId"
    );

    return prisma.batchTaskRun.findFirst({
      where: { friendlyId, runtimeEnvironmentId: environmentId },
      ...(args?.include ? { include: args.include } : {}),
    }) as Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null>;
  }

  // Defaults to the primary: the idempotency probe reads a batch that may have just been
  // written within the same request.
  async findBatchTaskRunByIdempotencyKey<T extends Prisma.BatchTaskRunInclude = {}>(
    environmentId: string,
    idempotencyKey: string,
    args?: { include?: T },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null> {
    const prisma = client ?? this.prisma;

    this.#assertSubsetSelectable(
      args?.include as Record<string, unknown> | undefined,
      BATCH_TASK_RUN_CONTROL_PLANE_RELATIONS,
      "findBatchTaskRunByIdempotencyKey"
    );

    return prisma.batchTaskRun.findFirst({
      where: { runtimeEnvironmentId: environmentId, idempotencyKey },
      ...(args?.include ? { include: args.include } : {}),
    }) as Promise<Prisma.BatchTaskRunGetPayload<{ include: T }> | null>;
  }

  async updateManyBatchTaskRun(
    args: Prisma.BatchTaskRunUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    const prisma = tx ?? this.prisma;

    return prisma.batchTaskRun.updateMany(args);
  }

  async countBatchTaskRunItems(
    where: { batchTaskRunId: string; status?: BatchTaskRunItemStatus },
    client?: ReadClient
  ): Promise<number> {
    const prisma = client ?? this.prisma;

    return prisma.batchTaskRunItem.count({ where });
  }

  async updateManyBatchTaskRunItems(
    args: Prisma.BatchTaskRunItemUpdateManyArgs,
    tx?: PrismaClientOrTransaction
  ): Promise<Prisma.BatchPayload> {
    const prisma = tx ?? this.prisma;

    return prisma.batchTaskRunItem.updateMany(args);
  }

  // The item's `batchTaskRun`/`taskRun` relations stay real FKs on BOTH schemas (co-resident), so a
  // caller `include` passes straight through — no dedicated-subset stripping is needed.
  async findManyBatchTaskRunItems<I extends Prisma.BatchTaskRunItemInclude = {}>(
    where: { taskRunId?: string; batchTaskRunId?: string },
    args?: { include?: I },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunItemGetPayload<{ include: I }>[]> {
    const prisma = client ?? this.readOnlyPrisma;

    return prisma.batchTaskRunItem.findMany({
      where,
      ...(args?.include ? { include: args.include } : {}),
    }) as Promise<Prisma.BatchTaskRunItemGetPayload<{ include: I }>[]>;
  }

  async findBatchTaskRunItem<I extends Prisma.BatchTaskRunItemInclude = {}>(
    where: { batchTaskRunId: string; taskRunId?: string },
    args?: { include?: I },
    client?: ReadClient
  ): Promise<Prisma.BatchTaskRunItemGetPayload<{ include: I }> | null> {
    const prisma = client ?? this.readOnlyPrisma;

    return prisma.batchTaskRunItem.findFirst({
      where,
      ...(args?.include ? { include: args.include } : {}),
    }) as Promise<Prisma.BatchTaskRunItemGetPayload<{ include: I }> | null>;
  }

  // --- WaitpointTag (run-ops) ---

  async upsertWaitpointTag(
    data: { environmentId: string; name: string; projectId: string; id?: string },
    tx?: PrismaClientOrTransaction
  ): Promise<WaitpointTag> {
    const prisma = tx ?? this.prisma;

    return prisma.waitpointTag.upsert({
      where: { environmentId_name: { environmentId: data.environmentId, name: data.name } },
      create: {
        ...(data.id !== undefined && { id: data.id }),
        name: data.name,
        environmentId: data.environmentId,
        projectId: data.projectId,
      },
      update: {},
    }) as Promise<WaitpointTag>;
  }

  async findManyWaitpointTags(
    args: {
      where: Prisma.WaitpointTagWhereInput;
      orderBy?:
        | Prisma.WaitpointTagOrderByWithRelationInput
        | Prisma.WaitpointTagOrderByWithRelationInput[];
      take?: number;
      skip?: number;
    },
    client?: ReadClient
  ): Promise<WaitpointTag[]> {
    const prisma = client ?? this.readOnlyPrisma;

    return prisma.waitpointTag.findMany(args) as Promise<WaitpointTag[]>;
  }

  /**
   * Run `taskRun.update` honoring a caller `{ select | include }` that may name dedicated-schema
   * relation keys. Legacy passes through unchanged; dedicated strips + hydrates via the shared adapter.
   */
  #updateTaskRunWithSelect(
    prisma: RunOpsCapableClient,
    where: Prisma.TaskRunWhereUniqueInput,
    data: any,
    args: { select?: any; include?: any }
  ): Promise<any> {
    if (this.schemaVariant !== "dedicated") {
      return prisma.taskRun.update({ where, data, ...args });
    }
    return this.#runDedicatedSelect(
      prisma,
      (stripped) => prisma.taskRun.update({ where, data, ...stripped }),
      args,
      TASK_RUN_DEDICATED
    );
  }

  /** Run `taskRun.findFirst`/`findFirstOrThrow` honoring a caller select/include (dedicated-schema-relation aware). */
  #findTaskRunWithSelect(
    prisma: ReadClient | RunOpsCapableClient,
    method: "findFirst" | "findFirstOrThrow",
    where: Prisma.TaskRunWhereInput,
    args: { select?: any; include?: any }
  ): Promise<any> {
    const delegate = (prisma as RunOpsCapableClient).taskRun;
    if (this.schemaVariant !== "dedicated") {
      return delegate[method]({ where, ...args });
    }
    return this.#runDedicatedSelect(
      prisma as RunOpsCapableClient,
      (stripped) => delegate[method]({ where, ...stripped }),
      args,
      TASK_RUN_DEDICATED
    );
  }

  // --- dedicated-schema caller-select adapter (P2-store-bodies-2) ---
  // On the dedicated subset the relation keys the run-engine selects don't exist (they're stripped on
  // the dedicated schema and hydrated from scalars/joins). We strip
  // them from the caller's select/include, run the query, then hydrate from the scalar/join model
  // and merge back so the returned shape is unchanged. Legacy passes the keys through unchanged.

  // Strip the dedicated-schema relation keys, run the single-result delegate query, then hydrate the stripped keys back.
  async #runDedicatedSelect(
    client: RunOpsCapableClient,
    runQuery: (strippedArgs: { select?: any; include?: any }) => Promise<any>,
    args: { select?: any; include?: any },
    spec: DedicatedRelationSpec
  ): Promise<any> {
    const { stripped, requested } = stripDedicatedRelations(args, spec);
    const row = await runQuery(stripped);
    if (!row) {
      return row;
    }
    await this.#hydrateDedicatedRelations(client, [row], requested, spec);
    return row;
  }

  // Hydrate each requested dedicated-schema relation key onto EVERY row in `rows` in ONE grouped
  // pass per key (never one query per row), honoring the caller's sub-select.
  async #hydrateDedicatedRelations(
    client: RunOpsCapableClient,
    rows: Record<string, unknown>[],
    requested: Record<string, SubProjection>,
    spec: DedicatedRelationSpec
  ): Promise<void> {
    for (const key of Object.keys(requested)) {
      const hydrator = spec[key];
      if (!hydrator) {
        continue;
      }
      const subArgs = requested[key];
      const byParentId = await hydrator(client, rows, projectionOf(subArgs), this);
      for (const row of rows) {
        row[key] = byParentId.get(row.id as string);
      }
    }
  }

  /**
   * The single-row read methods (`findRun`, `findRunOrThrow`) accept either
   * `(where, { select | include }, client?)` or the full-row `(where, client?)`.
   * Disambiguate the second positional arg: a `{ select }` / `{ include }`
   * projection object vs. a Prisma client. A projection object always carries a
   * `select` or `include` key; a Prisma client never does. Anything else (e.g.
   * `undefined`) is treated as "no projection, no explicit client".
   */
  #resolveReadArgs(
    argsOrClient:
      | { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude }
      | ReadClient
      | undefined,
    client: ReadClient | undefined
  ): {
    args: { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude };
    prisma: ReadClient | RunOpsCapableClient;
  } {
    const isProjection =
      typeof argsOrClient === "object" &&
      argsOrClient !== null &&
      ("select" in argsOrClient || "include" in argsOrClient);

    if (isProjection) {
      return {
        args: argsOrClient as { select?: Prisma.TaskRunSelect; include?: Prisma.TaskRunInclude },
        prisma: client ?? this.readOnlyPrisma,
      };
    }

    // No projection: the second positional arg, when present, is the client.
    return {
      args: {},
      prisma: (argsOrClient as ReadClient | undefined) ?? this.readOnlyPrisma,
    };
  }
}
