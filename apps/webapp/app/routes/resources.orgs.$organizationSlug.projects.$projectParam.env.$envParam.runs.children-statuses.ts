import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { type TaskRunStatus } from "@trigger.dev/database";
import { z } from "zod";
import { $replica } from "~/db.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { loadProjectEnvironmentFromRequest } from "~/services/loadProjectEnvironmentFromRequest.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { runIdsQueryParam } from "~/utils/searchParams";

const SearchParamsSchema = z.object({
  runIds: runIdsQueryParam,
});

const ROOT_CREATED_AT_SAFETY_MARGIN_MS = 5 * 60 * 1000;

type RootRun = { id: string; friendlyId: string; createdAt: Date };
type ChildStatusEntry = { status: TaskRunStatus; count: number };
type GroupedChildStatus = {
  rootRunId: string;
  status: TaskRunStatus;
  count: number;
};

function mapGroupedStatusesToFriendlyIds(
  grouped: GroupedChildStatus[],
  roots: RootRun[]
): Map<string, ChildStatusEntry[]> {
  const rootFriendlyIdById = new Map(roots.map((run) => [run.id, run.friendlyId]));
  const statusesByFriendlyId = new Map<string, ChildStatusEntry[]>();

  for (const item of grouped) {
    const friendlyId = rootFriendlyIdById.get(item.rootRunId);
    if (!friendlyId) continue;

    const existing = statusesByFriendlyId.get(friendlyId) ?? [];
    existing.push({
      status: item.status,
      count: item.count,
    });
    statusesByFriendlyId.set(friendlyId, existing);
  }

  return statusesByFriendlyId;
}

function childrenStatusesResponseForRunIds(
  runIds: string[],
  statusesByFriendlyId: Map<string, ChildStatusEntry[]>
) {
  return {
    runs: runIds.map((friendlyId) => ({
      friendlyId,
      statuses: (statusesByFriendlyId.get(friendlyId) ?? []).filter((entry) => entry.count > 0),
    })),
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { runIds } = SearchParamsSchema.parse(Object.fromEntries(url.searchParams));

  if (runIds.length === 0) {
    return { runs: [] };
  }

  const { project, environment } = await loadProjectEnvironmentFromRequest(request, params);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "runsList"
  );
  const runsRepository = new RunsRepository({ clickhouse, prisma: $replica });

  const { runs: roots } = await runsRepository.listRuns({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    runId: runIds,
    page: { size: 100 },
  });

  if (roots.length === 0) {
    return { runs: [] };
  }

  const earliestRootCreatedAtMs = Math.min(...roots.map((run) => run.createdAt.getTime()));
  const sinceMs = Math.max(0, earliestRootCreatedAtMs - ROOT_CREATED_AT_SAFETY_MARGIN_MS);

  const [queryError, groupedRows] = await clickhouse.taskRuns.getChildRunStatusCounts({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    rootRunIds: roots.map((run) => run.id),
    since: sinceMs,
  });

  if (queryError) {
    throw queryError;
  }

  const grouped: GroupedChildStatus[] = groupedRows.map((row) => ({
    rootRunId: row.root_run_id,
    status: row.status as TaskRunStatus,
    count: row.count,
  }));

  const statusesByFriendlyId = mapGroupedStatusesToFriendlyIds(grouped, roots);

  return childrenStatusesResponseForRunIds(runIds, statusesByFriendlyId);
}
