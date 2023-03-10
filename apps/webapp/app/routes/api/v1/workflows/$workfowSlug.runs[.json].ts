import { RuntimeEnvironment } from ".prisma/client";
import { json, LoaderArgs } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";

export async function loader({ params, request }: LoaderArgs) {
  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const url = new URL(request.url);

  const page = url.searchParams.get("page")
    ? Number(url.searchParams.get("page"))
    : 1; // Set the page number
  const limit = url.searchParams.get("limit")
    ? Number(url.searchParams.get("limit"))
    : 100; // Set the limit
  const offset = (page - 1) * limit; // Calculate the offset

  if (limit > 100) {
    return json({ error: "Limit cannot be greater than 100" }, { status: 400 });
  }

  const workflowRuns = await findRunsForWorkflowInEnv(
    params.workflowSlug as string,
    authenticatedEnv.organization.slug,
    authenticatedEnv,
    offset,
    limit
  );

  const totalCount = await countRunsForWorkflowInEnv(
    params.workflowSlug as string,
    authenticatedEnv.organization.slug,
    authenticatedEnv
  );

  const totalPages = Math.ceil(totalCount / limit); // Calculate the total pages

  return json({
    data: workflowRuns.map(workflowRunToJson),
    pagination: {
      page,
      totalPages,
      totalCount,
    },
  });
}

function workflowRunToJson(workflowRun: RunResult) {
  return {
    id: workflowRun.id,
    environmentId: workflowRun.environmentId,
    status: workflowRun.status,
    createdAt: workflowRun.createdAt,
    startedAt: workflowRun.startedAt ?? undefined,
    finishedAt: workflowRun.finishedAt ?? undefined,
    error: workflowRun.error ?? undefined,
    isTest: workflowRun.isTest,
    attempts: workflowRun.attemptCount,
    timedOutAt: workflowRun.timedOutAt ?? undefined,
    timedOutReason: workflowRun.timedOutReason ?? undefined,
    event: workflowRun.event,
    tasks: workflowRun.tasks,
  };
}

type RunsResult = Awaited<ReturnType<typeof findRunsForWorkflowInEnv>>;
type RunResult = RunsResult[number];

async function findRunsForWorkflowInEnv(
  workflowSlug: string,
  organizationSlug: string,
  env: RuntimeEnvironment,
  offset: number,
  limit: number
) {
  return prisma.workflowRun.findMany({
    where: {
      workflow: {
        slug: workflowSlug,
        organization: {
          slug: organizationSlug,
        },
      },
      environmentId: env.id,
    },
    orderBy: {
      createdAt: "desc",
    },
    include: {
      event: true,
      tasks: {
        orderBy: {
          createdAt: "asc",
        },
        take: 25,
      },
    },
    skip: offset,
    take: limit,
  });
}

async function countRunsForWorkflowInEnv(
  workflowSlug: string,
  organizationSlug: string,
  env: RuntimeEnvironment
) {
  return prisma.workflowRun.count({
    where: {
      workflow: {
        slug: workflowSlug,
        organization: {
          slug: organizationSlug,
        },
      },
      environmentId: env.id,
    },
  });
}
