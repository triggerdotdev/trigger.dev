import type { Prisma, PrismaClientOrTransaction, PrismaReplicaClient } from "@trigger.dev/database";
import type { FindRunTableScope } from "@internal/run-store";
import { runStore } from "~/v3/runStore.server";

type ReadClient = PrismaClientOrTransaction | PrismaReplicaClient;

/**
 * Resolve a run's parent and root runs across BOTH physical run tables.
 *
 * A run's `parentTaskRunId`/`rootTaskRunId` are plain scalar ids whose target
 * may live in either `TaskRun` (legacy cuid) or `task_run_v2` (new ksuid) — for
 * example a v2 child of a legacy parent, created while the org's `runTableV2`
 * flag was mid-flip. A single Prisma relation select (`parentTaskRun { ... }`)
 * is bound to one table and silently returns `null` for such a cross-table
 * parent/root. Resolving each by id instead lets RunStore route to the correct
 * table by id format. Pass the same `select` the caller would have used on the
 * relation.
 *
 * The lookups are scoped to the run's `runtimeEnvironmentId`: the parent/root
 * pointers are plain scalars with no FK enforcement, so a stale or malformed
 * pointer could otherwise resolve to a run in another environment and leak its
 * metadata. The relation select this replaces was implicitly same-environment.
 */
export async function hydrateParentAndRoot<S extends Prisma.TaskRunSelect>(
  ids: { parentTaskRunId: string | null; rootTaskRunId: string | null },
  scope: { runtimeEnvironmentId: string; tables?: FindRunTableScope },
  select: S,
  client?: ReadClient
): Promise<{
  parentTaskRun: Prisma.TaskRunGetPayload<{ select: S }> | null;
  rootTaskRun: Prisma.TaskRunGetPayload<{ select: S }> | null;
}> {
  const [parentTaskRun, rootTaskRun] = await Promise.all([
    ids.parentTaskRunId
      ? runStore.findRun(
          { id: ids.parentTaskRunId, runtimeEnvironmentId: scope.runtimeEnvironmentId },
          { select, tables: scope.tables },
          client
        )
      : Promise.resolve(null),
    ids.rootTaskRunId
      ? runStore.findRun(
          { id: ids.rootTaskRunId, runtimeEnvironmentId: scope.runtimeEnvironmentId },
          { select, tables: scope.tables },
          client
        )
      : Promise.resolve(null),
  ]);

  return {
    parentTaskRun: parentTaskRun as Prisma.TaskRunGetPayload<{ select: S }> | null,
    rootTaskRun: rootTaskRun as Prisma.TaskRunGetPayload<{ select: S }> | null,
  };
}

/**
 * A run's direct child runs across BOTH physical tables. Children reference the
 * parent by the scalar `parentTaskRunId`, and a v2 parent can have legacy cuid
 * children (or vice versa) in the mixed window, so this is a non-id predicate
 * read that `findRuns` resolves against both tables. Scoped to the run's
 * `runtimeEnvironmentId` so a stale/malformed `parentTaskRunId` pointer can't
 * surface children from another environment.
 */
export async function hydrateChildRuns<S extends Prisma.TaskRunSelect>(
  parentRunId: string,
  scope: { runtimeEnvironmentId: string; tables?: FindRunTableScope },
  select: S,
  client?: ReadClient
): Promise<Prisma.TaskRunGetPayload<{ select: S }>[]> {
  return runStore.findRuns(
    {
      where: {
        parentTaskRunId: parentRunId,
        runtimeEnvironmentId: scope.runtimeEnvironmentId,
      },
      select,
      // parentTaskRunId is a non-id predicate, so this reads BOTH tables by
      // default. Callers that know the org isn't on v2 pass tables:"legacy" to
      // skip the empty task_run_v2 query.
      tables: scope.tables,
    },
    client
  ) as Promise<Prisma.TaskRunGetPayload<{ select: S }>[]>;
}
