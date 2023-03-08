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

  let latestLogAt: number = deployment.logs[0]?.createdAt.getTime() ?? 0;
  let lastUpdatedAt: number = deployment.updatedAt.getTime();

  return eventStream(request.signal, (send) => {
    const pinger = setInterval(() => {
      send({ event: "ping", data: new Date().toISOString() });
    }, 1000);

    const interval = setInterval(() => {
      findDeploymentWithLatestLog(id).then((deployment) => {
        if (deployment) {
          if (lastUpdatedAt !== deployment.updatedAt.getTime()) {
            send({ event: "update", data: deployment.updatedAt.toISOString() });
          } else if (
            deployment.logs[0] &&
            latestLogAt !== deployment.logs[0].createdAt.getTime()
          ) {
            send({
              event: "update",
              data: deployment.logs[0]?.createdAt.toISOString(),
            });
          }

          latestLogAt = deployment.logs[0]?.createdAt.getTime();
          lastUpdatedAt = deployment.updatedAt.getTime();
        }
      });
    }, 1000);

    return function clear() {
      clearInterval(interval);
      clearInterval(pinger);
    };
  });
}

async function findDeploymentWithLatestLog(id: string) {
  return await prisma.projectDeployment.findUnique({
    where: { id },
    include: {
      logs: {
        take: 1,
        orderBy: [{ createdAt: "desc" }],
      },
    },
  });
}
