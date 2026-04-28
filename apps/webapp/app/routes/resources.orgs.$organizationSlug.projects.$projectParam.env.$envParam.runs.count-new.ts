import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { $replica, type PrismaClient } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { getRunFiltersFromRequest } from "~/presenters/RunFilters.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { RunsRepository } from "~/services/runsRepository/runsRepository.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";

const COUNT_CAP = 99;
const RunIdSchema = z.string().cuid();

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);
  const { projectParam, organizationSlug, envParam } = EnvironmentParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Project not found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Environment not found", { status: 404 });
  }

  const url = new URL(request.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam && RunIdSchema.safeParse(sinceParam).success ? sinceParam : null;

  if (!since) {
    return typedjson(
      { count: 0, hasMore: false },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  const filters = await getRunFiltersFromRequest(request);

  const runsRepository = new RunsRepository({
    clickhouse: clickhouseClient,
    prisma: $replica as PrismaClient,
  });

  const ids = await runsRepository.listRunIds({
    organizationId: project.organizationId,
    projectId: project.id,
    environmentId: environment.id,
    tasks: filters.tasks,
    versions: filters.versions,
    statuses: filters.statuses,
    tags: filters.tags,
    period: filters.period,
    from: filters.from,
    to: filters.to,
    batchId: filters.batchId,
    runId: filters.runId,
    bulkId: filters.bulkId,
    scheduleId: filters.scheduleId,
    rootOnly: filters.rootOnly,
    queues: filters.queues,
    machines: filters.machines,
    errorId: filters.errorId,
    page: { cursor: since, direction: "backward", size: COUNT_CAP },
  });

  return typedjson(
    {
      count: Math.min(ids.length, COUNT_CAP),
      hasMore: ids.length > COUNT_CAP,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
};
