import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { mapRunToLiveFields } from "~/presenters/v3/mapRunToLiveFields.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { loadProjectEnvironmentFromRequest } from "~/services/loadProjectEnvironmentFromRequest.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { runIdsQueryParam } from "~/utils/searchParams";

const SearchParamsSchema = z.object({
  runIds: runIdsQueryParam,
  includeNewRuns: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  since: z.coerce.number().optional(),
});

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const { runIds, includeNewRuns, since } = SearchParamsSchema.parse(
    Object.fromEntries(url.searchParams)
  );

  const newRunsSince = includeNewRuns && since !== undefined ? since : undefined;

  if (runIds.length === 0 && newRunsSince === undefined) {
    return { runs: [] };
  }

  const { project, environment } = await loadProjectEnvironmentFromRequest(request, params);

  const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
    project.organizationId,
    "standard"
  );
  const runsRepository = new RunsRepository({ clickhouse, prisma: $replica });

  const [runs, newRunsResult] = await Promise.all([
    runIds.length > 0
      ? runsRepository
          .listRuns({
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
            runId: runIds,
            page: { size: 100 },
          })
          .then(({ runs: listedRuns }) => listedRuns.map(mapRunToLiveFields))
      : Promise.resolve([]),
    newRunsSince !== undefined
      ? (async () => {
          const filters = await getRunFiltersFromRequest(request);

          if (filters.to !== undefined && filters.to <= newRunsSince) {
            return { count: 0, since: newRunsSince };
          }

          const { runIds: newRunIds } = await runsRepository.listRunIds({
            organizationId: project.organizationId,
            projectId: project.id,
            environmentId: environment.id,
            tasks: filters.tasks,
            versions: filters.versions,
            statuses: filters.statuses,
            tags: filters.tags,
            scheduleId: filters.scheduleId,
            period: filters.period,
            from: Math.max(filters.from ?? 0, newRunsSince + 1),
            to: filters.to,
            rootOnly: filters.rootOnly,
            batchId: filters.batchId,
            runId: filters.runId,
            bulkId: filters.bulkId,
            queues: filters.queues,
            machines: filters.machines,
            errorId: filters.errorId,
            page: { size: 100 },
          });

          return { count: newRunIds.length, since: newRunsSince };
        })()
      : Promise.resolve(undefined),
  ]);

  if (newRunsResult) {
    return { runs, ...newRunsResult };
  }

  return { runs };
}
