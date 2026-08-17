import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { deriveRunSelect } from "~/components/runs/v3/runColumns";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { loadProjectEnvironmentFromRequest } from "~/services/loadProjectEnvironmentFromRequest.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { $replica } from "~/db.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

/** How many recent runs the smart-column preview can page through. */
const SAMPLE_RUN_COUNT = 10;

/**
 * The most recent runs for the current filters, with their raw
 * payload/metadata/output packets, feeding the "Add smart column" preview. The
 * client picks which run to sample, parses, and resolves the JSON path; the
 * server never parses (same rule as the list).
 */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const { project, environment } = await loadProjectEnvironmentFromRequest(request, params);
  const filters = await getRunFiltersFromRequest(request);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "runsList"
  );
  const runsRepository = new RunsRepository({ clickhouse, prisma: $replica });

  const { runs } = await runsRepository.listRuns({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    tasks: filters.tasks,
    versions: filters.versions,
    statuses: filters.statuses,
    tags: filters.tags,
    scheduleId: filters.scheduleId,
    period: filters.period,
    from: filters.from,
    to: filters.to,
    rootOnly: filters.rootOnly,
    batchId: filters.batchId,
    runId: filters.runId,
    bulkId: filters.bulkId,
    queues: filters.queues,
    machines: filters.machines,
    errorId: filters.errorId,
    runSelect: deriveRunSelect([], ["payload", "metadata", "output"]),
    page: { size: SAMPLE_RUN_COUNT },
  });

  return {
    runs: runs.map((run) => ({
      friendlyId: run.friendlyId,
      status: run.status,
      hasFinished: isFinalRunStatus(run.status),
      startedAt: (run.startedAt ?? run.lockedAt)?.toISOString(),
      createdAt: run.createdAt.toISOString(),
      payload: run.payload,
      payloadType: run.payloadType,
      metadata: run.metadata,
      metadataType: run.metadataType,
      output: run.output,
      outputType: run.outputType,
    })),
  };
}
