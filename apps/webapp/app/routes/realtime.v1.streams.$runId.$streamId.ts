import { z } from "zod";
import { $replica } from "~/db.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth) => {
      return $replica.taskRun.findFirst({
        where: {
          friendlyId: params.runId,
          runtimeEnvironmentId: auth.environment.id,
        },
        include: {
          batch: {
            select: {
              friendlyId: true,
            },
          },
        },
      });
    },
    authorization: {
      action: "read",
      resource: (run) => ({
        runs: run.friendlyId,
        tags: run.runTags,
        batch: run.batch?.friendlyId,
        tasks: run.taskIdentifier,
      }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ params, request, resource: run, authentication }) => {
    // Get Last-Event-ID header for resuming from a specific position
    const lastEventId = request.headers.get("Last-Event-ID") || undefined;

    const timeoutInSecondsRaw = request.headers.get("Timeout-Seconds") ?? undefined;
    const timeoutInSeconds = timeoutInSecondsRaw ? parseInt(timeoutInSecondsRaw) : undefined;

    if (timeoutInSeconds && isNaN(timeoutInSeconds)) {
      return new Response("Invalid timeout seconds", { status: 400 });
    }

    if (timeoutInSeconds && timeoutInSeconds < 1) {
      return new Response("Timeout seconds must be greater than 0", { status: 400 });
    }

    if (timeoutInSeconds && timeoutInSeconds > 600) {
      return new Response("Timeout seconds must be less than 600", { status: 400 });
    }

    const realtimeStream = getRealtimeStreamInstance(
      authentication.environment,
      run.realtimeStreamsVersion
    );

    return realtimeStream.streamResponse(request, run.friendlyId, params.streamId, request.signal, {
      lastEventId,
      timeoutInSeconds,
    });
  }
);
