import { LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { sse } from "~/utils/sse";

export async function loader({ request, params }: LoaderArgs) {
  await requireUserId(request);

  const { projectId } = z.object({ projectId: z.string() }).parse(params);

  const project = await projectForUpdates(projectId);

  if (!project) {
    return new Response("Not found", { status: 404 });
  }

  let lastSignals = calculateChangeSignals(project);

  return sse({
    request,
    run: async (send, stop) => {
      const result = await projectForUpdates(projectId);
      if (!result) {
        return stop();
      }

      const newSignals = calculateChangeSignals(result);

      if (lastSignals.jobCount !== newSignals.jobCount) {
        send({ data: JSON.stringify(newSignals) });
      }

      lastSignals = newSignals;
    },
  });
}

function projectForUpdates(id: string) {
  return prisma.project.findUnique({
    where: {
      id,
    },
    include: {
      _count: {
        select: { jobs: true },
      },
    },
  });
}

function calculateChangeSignals(
  project: NonNullable<Awaited<ReturnType<typeof projectForUpdates>>>
) {
  const jobCount = project._count?.jobs ?? 0;

  return {
    jobCount,
  };
}
