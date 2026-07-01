import { type PrismaClient } from "@trigger.dev/database";
import { type RunOpsPrismaClient } from "@internal/run-ops-database";
import { runOpsLegacyPrisma, runOpsNewPrismaClient } from "~/db.server";

/**
 * Structural client covering exactly the run-subgraph delegates + WHERE filters the cascade uses on
 * a run-ops writer. Both `@trigger.dev/database`'s `PrismaClient` (full schema, legacy writer) and
 * `@internal/run-ops-database`'s `RunOpsPrismaClient` (dedicated SUBSET schema, new writer) are
 * assignable to it — the two concrete clients are NOT mutually assignable (the subset adds FK-free
 * join models the full schema lacks), so a shared structural type is the only common ground.
 *
 * Crucially it does NOT expose control-plane-resident models (e.g. `bulkActionItem`) nor scalarized
 * relations that don't exist on the subset (e.g. `TaskRunWaitpoint.taskRun`), so the compiler now
 * rejects the two bugs an `as unknown as PrismaClient` cast would otherwise mask.
 */
type CountResult = { count: number };
type RunSubgraphCleanupClient = {
  taskRun: {
    findMany(args: {
      where: { runtimeEnvironmentId: string };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
    deleteMany(args: {
      where: { runtimeEnvironmentId: string } | { projectId: string };
    }): Promise<CountResult>;
  };
  taskRunAttempt: {
    deleteMany(args: {
      where: { runtimeEnvironmentId: string } | { taskRun: { projectId: string } };
    }): Promise<CountResult>;
  };
  taskRunWaitpoint: {
    deleteMany(args: {
      where: { taskRunId: { in: string[] } } | { projectId: string };
    }): Promise<CountResult>;
  };
  taskRunCheckpoint: {
    deleteMany(args: {
      where: { runtimeEnvironmentId: string } | { projectId: string };
    }): Promise<CountResult>;
  };
  checkpoint: {
    deleteMany(args: {
      where: { runtimeEnvironmentId: string } | { projectId: string };
    }): Promise<CountResult>;
  };
  checkpointRestoreEvent: {
    deleteMany(args: {
      where: { runtimeEnvironmentId: string } | { projectId: string };
    }): Promise<CountResult>;
  };
  waitpoint: {
    deleteMany(args: {
      where: { environmentId: string } | { projectId: string };
    }): Promise<CountResult>;
  };
  batchTaskRun: {
    deleteMany(args: {
      where: { runtimeEnvironmentId: string } | { runs: { some: { projectId: string } } };
    }): Promise<CountResult>;
  };
};

// Compile-time assertion that both concrete writers satisfy the structural shape.
const _newWriterAssignable: RunSubgraphCleanupClient = undefined as unknown as RunOpsPrismaClient;
const _legacyWriterAssignable: RunSubgraphCleanupClient = undefined as unknown as PrismaClient;
void _newWriterAssignable;
void _legacyWriterAssignable;

/**
 * RunOpsCascadeCleanupService — application-level env/project-delete cascade-cleanup that replaces
 * the cloud-only dropped cross-seam `onDelete: Cascade` FKs crossing run-ops -> control-plane.
 *
 * Deletes route through the dedicated run-ops write clients (`runOpsNewPrismaClient` +
 * `runOpsLegacyPrisma`), NOT the control-plane `prisma`. The ordered delete pass runs against BOTH
 * writers: a migrating env/project's run-ops rows split across the new (KSUID) and
 * legacy (cuid) DBs per the per-env cutover + roll-new-forward rollback, and the
 * cloud DB that lost its physical FK has no cascade to clean the other writer's miss. In single-DB
 * both handles are reference-equal to the one collapsed client, so de-dup-by-reference runs the
 * pass once; the FK cascade also fires there, making these deletes idempotent no-ops.
 *
 * The NEW run-ops writer is a dedicated `RunOpsPrismaClient` over the run-subgraph SUBSET schema:
 * it does NOT carry control-plane-resident models. `BulkActionItem` is one such control-plane model
 * (it lives in `@trigger.dev/database` but NOT in the run-ops subset), so cleaning it on the NEW
 * writer would dereference an `undefined` delegate at runtime. Its cleanup therefore runs ONLY
 * against the control-plane writer; the run-subgraph deletes (which DO exist on both schemas) run
 * per run-ops writer. Typing the run-ops writers as `RunOpsPrismaClient` makes the compiler reject
 * any future control-plane-only model access on the NEW writer, so this class of bug can't recur.
 *
 * Deliberately NOT gated behind `isSplitEnabled()` (cloud relies on it; self-host treats it as
 * idempotent insurance). Every delete is `deleteMany`, so a zero-row scope is a no-op and rows a
 * concurrent FK cascade already removed return `count: 0`. Deletes are not wrapped in one
 * `$transaction` (no cross-DB txn is possible, and a single huge txn risks long locks); a crash
 * mid-cleanup is recovered by re-running.
 */

/** Per-table deleted row counts, summed across the distinct run-ops writers actually run. */
type CascadeCleanupResult = Record<string, number>;

type CleanupServiceDeps = {
  /**
   * Run-ops write clients to run the run-subgraph delete pass against. Defaults to the two
   * run-ops writers — NOT the control-plane `prisma`. Typed as the structural
   * `RunSubgraphCleanupClient` so the compiler rejects control-plane-only model access (e.g.
   * `bulkActionItem`) and subset-absent relations. De-duped by reference so the single-DB
   * reference-equal collapse runs the pass once.
   */
  runOpsWriters?: RunSubgraphCleanupClient[];
  /**
   * Control-plane writer for control-plane-resident models the run-subgraph cascade must also clean
   * (currently only `BulkActionItem`, which has no env/project column and is NOT in the run-ops
   * subset schema). Runs exactly once. Defaults to the legacy run-ops writer, which IS the
   * control-plane client.
   */
  controlPlaneWriter?: PrismaClient;
};

export class RunOpsCascadeCleanupService {
  #writers: RunSubgraphCleanupClient[];
  #controlPlaneWriter: PrismaClient;

  constructor(deps: CleanupServiceDeps = {}) {
    const writers = deps.runOpsWriters ?? [runOpsNewPrismaClient, runOpsLegacyPrisma];
    this.#writers = Array.from(new Set(writers));
    this.#controlPlaneWriter = deps.controlPlaneWriter ?? runOpsLegacyPrisma;
  }

  /** Delete all run-ops rows scoped to one environment, across every distinct run-ops writer. */
  public async cleanupEnvironment(runtimeEnvironmentId: string): Promise<CascadeCleanupResult> {
    const result: CascadeCleanupResult = {};
    await this.#cleanupBulkActionItemsForEnvironment(runtimeEnvironmentId, result);
    for (const writer of this.#writers) {
      await this.#cleanupEnvironmentOnWriter(writer, runtimeEnvironmentId, result);
    }
    return result;
  }

  /** Delete all run-ops rows scoped to one project, across every distinct run-ops writer. */
  public async cleanupProject(projectId: string): Promise<CascadeCleanupResult> {
    const result: CascadeCleanupResult = {};
    await this.#cleanupBulkActionItemsForProject(projectId, result);
    for (const writer of this.#writers) {
      await this.#cleanupProjectOnWriter(writer, projectId, result);
    }
    return result;
  }

  // BulkActionItem is control-plane-resident (it exists in @trigger.dev/database, NOT in the
  // run-ops subset schema), so it is cleaned only on the control-plane writer. It has no env column;
  // clean via both run relations (destination may differ).
  async #cleanupBulkActionItemsForEnvironment(
    runtimeEnvironmentId: string,
    result: CascadeCleanupResult
  ): Promise<void> {
    await this.#accumulate(result, "bulkActionItem", async () => {
      const a = await this.#controlPlaneWriter.bulkActionItem.deleteMany({
        where: { sourceRun: { runtimeEnvironmentId } },
      });
      const b = await this.#controlPlaneWriter.bulkActionItem.deleteMany({
        where: { destinationRun: { runtimeEnvironmentId } },
      });
      return a.count + b.count;
    });
  }

  // BulkActionItem has no projectId column; clean via both run relations.
  async #cleanupBulkActionItemsForProject(
    projectId: string,
    result: CascadeCleanupResult
  ): Promise<void> {
    await this.#accumulate(result, "bulkActionItem", async () => {
      const a = await this.#controlPlaneWriter.bulkActionItem.deleteMany({
        where: { sourceRun: { projectId } },
      });
      const b = await this.#controlPlaneWriter.bulkActionItem.deleteMany({
        where: { destinationRun: { projectId } },
      });
      return a.count + b.count;
    });
  }

  // Child-before-parent ordering: an FK-retained DB never errors on an out-of-order delete, and an
  // FK-dropped DB leaves no orphans. TaskRun self-relations and TaskRun.batchId are SetNull, so a
  // single deleteMany of all scoped TaskRuns is order-safe within the table; Waitpoint's run/batch
  // links are SetNull (nullable) so its position is for tidiness only.
  async #cleanupEnvironmentOnWriter(
    writer: RunSubgraphCleanupClient,
    runtimeEnvironmentId: string,
    result: CascadeCleanupResult
  ): Promise<void> {
    await this.#accumulate(result, "checkpointRestoreEvent", () =>
      writer.checkpointRestoreEvent
        .deleteMany({ where: { runtimeEnvironmentId } })
        .then((r) => r.count)
    );
    await this.#accumulate(result, "checkpoint", () =>
      writer.checkpoint.deleteMany({ where: { runtimeEnvironmentId } }).then((r) => r.count)
    );
    await this.#accumulate(result, "taskRunCheckpoint", () =>
      writer.taskRunCheckpoint.deleteMany({ where: { runtimeEnvironmentId } }).then((r) => r.count)
    );
    // TaskRunWaitpoint has neither an env column nor (on the subset schema) a `taskRun` relation to
    // filter through, so resolve the scoped run ids first and delete by the scalar `taskRunId`.
    await this.#accumulate(result, "taskRunWaitpoint", async () => {
      const runs = await writer.taskRun.findMany({
        where: { runtimeEnvironmentId },
        select: { id: true },
      });
      if (runs.length === 0) return 0;
      const r = await writer.taskRunWaitpoint.deleteMany({
        where: { taskRunId: { in: runs.map((run) => run.id) } },
      });
      return r.count;
    });
    // Waitpoint's env column is `environmentId`, NOT `runtimeEnvironmentId`.
    await this.#accumulate(result, "waitpoint", () =>
      writer.waitpoint
        .deleteMany({ where: { environmentId: runtimeEnvironmentId } })
        .then((r) => r.count)
    );
    await this.#accumulate(result, "taskRunAttempt", () =>
      writer.taskRunAttempt.deleteMany({ where: { runtimeEnvironmentId } }).then((r) => r.count)
    );
    await this.#accumulate(result, "batchTaskRun", () =>
      writer.batchTaskRun.deleteMany({ where: { runtimeEnvironmentId } }).then((r) => r.count)
    );
    await this.#accumulate(result, "taskRun", () =>
      writer.taskRun.deleteMany({ where: { runtimeEnvironmentId } }).then((r) => r.count)
    );
  }

  async #cleanupProjectOnWriter(
    writer: RunSubgraphCleanupClient,
    projectId: string,
    result: CascadeCleanupResult
  ): Promise<void> {
    await this.#accumulate(result, "checkpointRestoreEvent", () =>
      writer.checkpointRestoreEvent.deleteMany({ where: { projectId } }).then((r) => r.count)
    );
    await this.#accumulate(result, "checkpoint", () =>
      writer.checkpoint.deleteMany({ where: { projectId } }).then((r) => r.count)
    );
    await this.#accumulate(result, "taskRunCheckpoint", () =>
      writer.taskRunCheckpoint.deleteMany({ where: { projectId } }).then((r) => r.count)
    );
    await this.#accumulate(result, "taskRunWaitpoint", () =>
      writer.taskRunWaitpoint.deleteMany({ where: { projectId } }).then((r) => r.count)
    );
    await this.#accumulate(result, "waitpoint", () =>
      writer.waitpoint.deleteMany({ where: { projectId } }).then((r) => r.count)
    );
    // TaskRunAttempt has no projectId column; clean via its TaskRun relation.
    await this.#accumulate(result, "taskRunAttempt", () =>
      writer.taskRunAttempt.deleteMany({ where: { taskRun: { projectId } } }).then((r) => r.count)
    );
    // BatchTaskRun has no projectId column; clean via its TaskRun (`runs`) members.
    await this.#accumulate(result, "batchTaskRun", () =>
      writer.batchTaskRun
        .deleteMany({ where: { runs: { some: { projectId } } } })
        .then((r) => r.count)
    );
    await this.#accumulate(result, "taskRun", () =>
      writer.taskRun.deleteMany({ where: { projectId } }).then((r) => r.count)
    );
  }

  async #accumulate(
    result: CascadeCleanupResult,
    table: string,
    run: () => Promise<number>
  ): Promise<void> {
    const count = await run();
    result[table] = (result[table] ?? 0) + count;
  }
}
