import { LoaderArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { sse } from "~/utils/sse";

export async function loader({ request, params }: LoaderArgs) {
  await requireUserId(request);

  const { environmentParam } = z
    .object({ environmentParam: z.string() })
    .parse(params);

  const environment = await environmentForUpdates(environmentParam);

  if (!environment) {
    return new Response("Not found", { status: 404 });
  }

  let lastSignals = calculateChangeSignals(environment);

  return sse({
    request,
    run: async (send, stop) => {
      const result = await environmentForUpdates(environmentParam);
      if (!result) {
        return stop();
      }

      const newSignals = calculateChangeSignals(result);

      if (lastSignals.lastUpdatedAt !== result.updatedAt.getTime()) {
        send({ data: result.updatedAt.toISOString() });
      } else if (
        lastSignals.lastTotalEndpointUpdatedTime !==
        newSignals.lastTotalEndpointUpdatedTime
      ) {
        send({ data: new Date().toISOString() });
      } else if (
        lastSignals.lastTotalIndexingUpdatedTime !==
        newSignals.lastTotalIndexingUpdatedTime
      ) {
        send({ data: new Date().toISOString() });
      }

      lastSignals = newSignals;
    },
  });
}

function environmentForUpdates(id: string) {
  return prisma.runtimeEnvironment.findUnique({
    where: {
      id,
    },
    select: {
      updatedAt: true,
      endpoints: {
        select: {
          updatedAt: true,
          indexings: {
            select: {
              updatedAt: true,
            },
          },
        },
      },
    },
  });
}

function calculateChangeSignals(
  environment: NonNullable<Awaited<ReturnType<typeof environmentForUpdates>>>
) {
  let lastUpdatedAt: number = environment.updatedAt.getTime();
  let lastTotalEndpointUpdatedTime = environment.endpoints.reduce(
    (prev, endpoint) => prev + endpoint.updatedAt.getTime(),
    0
  );
  let lastTotalIndexingUpdatedTime = environment.endpoints.reduce(
    (prev, endpoint) =>
      prev +
      endpoint.indexings.reduce(
        (prev, indexing) => prev + indexing.updatedAt.getTime(),
        0
      ),
    0
  );

  return {
    lastUpdatedAt,
    lastTotalEndpointUpdatedTime,
    lastTotalIndexingUpdatedTime,
  };
}
