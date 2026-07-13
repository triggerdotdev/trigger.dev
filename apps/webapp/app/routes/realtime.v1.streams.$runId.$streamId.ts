import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { getRealtimeStreamInstance } from "~/services/realtime/v1StreamsGlobal.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { runStore } from "~/v3/runStore.server";

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
      const run = await runStore.findRun(
        {
          friendlyId: params.runId,
          runtimeEnvironmentId: auth.environment.id,
        },
        {
          select: {
            id: true,
            friendlyId: true,
            taskIdentifier: true,
            runTags: true,
            realtimeStreamsVersion: true,
            streamBasinName: true,
            batch: {
              select: {
                friendlyId: true,
              },
            },
          },
        },
        $replica
      );
      return run;
    },
    authorization: {
      action: "read",
      resource: (run) => {
        const resources = [
          { type: "runs", id: run.friendlyId },
          { type: "tasks", id: run.taskIdentifier },
          ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
        ];
        if (run.batch?.friendlyId) {
          resources.push({ type: "batch", id: run.batch.friendlyId });
        }
        return anyResource(resources);
      },
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
      run.realtimeStreamsVersion,
      { run }
    );

    return realtimeStream.streamResponse(
      request,
      run.friendlyId,
      params.streamId,
      getRequestAbortSignal(),
      {
        lastEventId,
        timeoutInSeconds,
      }
    );
  }
);
