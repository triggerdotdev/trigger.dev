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

  if (typeof params.runId !== "string") {
    return json({ error: "Invalid run id" }, { status: 400 });
  }

  try {
    const workflowRun = await findRunForWorkflowInEnv(
      params.runId,
      authenticatedEnv
    );

    return json(workflowRunToJson(workflowRun));
  } catch (e) {
    return json({ error: "Run not found" }, { status: 404 });
  }
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

type RunResult = Awaited<ReturnType<typeof findRunForWorkflowInEnv>>;

async function findRunForWorkflowInEnv(runId: string, env: RuntimeEnvironment) {
  return prisma.workflowRun.findFirstOrThrow({
    where: {
      id: runId,
      environmentId: env.id,
    },
    include: {
      event: true,
      tasks: {
        orderBy: {
          createdAt: "asc",
        },
        take: 100,
      },
    },
  });
}
