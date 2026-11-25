import { boundedIn } from "@trigger.dev/database";
import type { RunStore } from "@internal/run-store";
import type { RunEngine } from "@internal/run-engine";
import { parseWaitpointId, WaitpointId } from "@trigger.dev/core/v3/isomorphic";

export function isStoreDateTimeWaitpoint(waitpointId: string) {
  const parsed = parseWaitpointId(waitpointId);
  return parsed.format !== "legacy" && (parsed.type === "DATETIME" || parsed.type === "MANUAL");
}

/** Call only after resolving the dashboard's authorized environment/project. */
export async function resolveDashboardDateTimeWaitpoint(
  scope: {
    friendlyId: string;
    environmentId: string;
    projectId: string;
    organizationId: string;
  },
  engine: Pick<RunEngine, "getStoreDateTimeWaitpoint">
) {
  return engine.getStoreDateTimeWaitpoint({
    waitpointId: WaitpointId.toId(scope.friendlyId),
    environmentId: scope.environmentId,
    projectId: scope.projectId,
    organizationId: scope.organizationId,
  });
}

/** Match deadline workers: a repeated skip must preserve the first completion. */
export async function skipDashboardDateTimeWaitpoint(
  waitpointId: string,
  organizationId: string,
  engine: Pick<RunEngine, "completeWaitpoint">
) {
  return engine.completeWaitpoint({ id: waitpointId, organizationId, onlyIfPending: true });
}

/** Filter dangling/foreign runs before filling the existing five-run dashboard display. */
export async function resolveDashboardWaitpointRelatedRuns(
  scope: { waitpointId: string; environmentId: string; projectId: string; organizationId: string },
  engine: Pick<RunEngine, "getStoreWaitpointRelatedRunIds">,
  runStore: Pick<RunStore, "findRuns">,
  // A standalone token's history comes newest first, in offset pages.
  standalone = false
): Promise<string[]> {
  const friendlyIds: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const { runIds: ids, nextCursor } = await engine.getStoreWaitpointRelatedRunIds({
      ...scope,
      cursor,
    });
    if (!ids.length) return friendlyIds;
    if (!standalone) {
      const runs = await runStore.findRuns({
        where: {
          id: { in: boundedIn(ids) },
          runtimeEnvironmentId: scope.environmentId,
          projectId: scope.projectId,
          organizationId: scope.organizationId,
        },
        select: { friendlyId: true },
        take: 5 - friendlyIds.length,
      });
      friendlyIds.push(...runs.map((run) => run.friendlyId));
      if (friendlyIds.length === 5 || !nextCursor) return friendlyIds;
      cursor = nextCursor;
      continue;
    }
    const runs = await runStore.findRuns({
      where: {
        id: { in: boundedIn(ids) },
        runtimeEnvironmentId: scope.environmentId,
        projectId: scope.projectId,
        organizationId: scope.organizationId,
      },
      select: { id: true, friendlyId: true },
    });
    const found = new Map(runs.map((run) => [run.id, run.friendlyId]));
    for (const id of ids) {
      const friendlyId = found.get(id);
      // A registration between pages shifts the offset cursor, so a run can come back next page.
      if (!friendlyId || friendlyIds.includes(friendlyId)) continue;
      friendlyIds.push(friendlyId);
      if (friendlyIds.length === 5) return friendlyIds;
    }
    if (!nextCursor) return friendlyIds;
    cursor = nextCursor;
  }
}
