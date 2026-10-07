import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runStore } from "~/v3/runStore.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

// Run terminal-state probe polled by the trace viewer's live tail backstop.
export type RunStatusData = { isFinished: boolean; completedAt: string | null };

export async function loader({ request, params }: LoaderFunctionArgs) {
  const userId = await requireUserId(request);
  const { projectParam, envParam, runParam } = v3RunParamsSchema.parse(params);

  const run = await runStore.findRun(
    { friendlyId: runParam },
    {
      select: { status: true, completedAt: true, projectId: true, runtimeEnvironmentId: true },
    }
  );

  if (!run) {
    throw new Response("Not found", { status: 404 });
  }

  // Membership-scoped auth, matching the trace-chunk route.
  const authorizedProject = await prisma.project.findFirst({
    where: {
      id: run.projectId,
      slug: projectParam,
      organization: { members: { some: { userId } } },
    },
    select: { id: true },
  });

  if (!authorizedProject) {
    throw new Response("Not found", { status: 404 });
  }

  const environment = await controlPlaneResolver.resolveAuthenticatedEnv(run.runtimeEnvironmentId);

  if (!environment || environment.slug !== envParam) {
    throw new Response("Not found", { status: 404 });
  }

  return json<RunStatusData>({
    isFinished: isFinalRunStatus(run.status),
    completedAt: run.completedAt ? run.completedAt.toISOString() : null,
  });
}
