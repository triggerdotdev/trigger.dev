import type { LoaderArgs } from "@remix-run/server-runtime";
import { eventStream } from "remix-utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";

export async function loader({ request, params }: LoaderArgs) {
  await requireUserId(request);

  const { id } = z.object({ id: z.string() }).parse(params);

  const deployment = await findDeploymentWithLatestLog(id);

  if (!deployment) {
    return new Response("Not found", { status: 404 });
  }

  let latestLogAt: number = deployment.polls[0]?.to.getTime() ?? 0;
  let lastUpdatedAt: number = deployment.updatedAt.getTime();

  let stopped = false;

  return eventStream(request.signal, (send) => {
    const pinger = setInterval(() => {
      send({ event: "ping", data: new Date().toISOString() });
    }, 1000);

    const interval = setInterval(() => {
      findDeploymentWithLatestLog(id).then((deployment) => {
        if (stopped) return;

        if (deployment) {
          if (lastUpdatedAt !== deployment.updatedAt.getTime()) {
            send({ event: "update", data: deployment.updatedAt.toISOString() });
          } else if (
            deployment.polls[0] &&
            latestLogAt !== deployment.polls[0].to.getTime()
          ) {
            send({
              event: "update",
              data: deployment.polls[0].to.toISOString(),
            });
          }

          latestLogAt = deployment.polls[0]?.to.getTime() ?? 0;
          lastUpdatedAt = deployment.updatedAt.getTime();
        }
      });
    }, 1000);

    return function clear() {
      stopped = true;
      clearInterval(interval);
      clearInterval(pinger);
    };
  });
}

async function findDeploymentWithLatestLog(id: string) {
  return await prisma.projectDeployment.findUnique({
    where: { id },
    include: {
      polls: {
        take: 1,
        orderBy: { createdAt: "desc" },
        where: {
          filteredLogsCount: { gt: 0 },
        },
      },
    },
  });
}
