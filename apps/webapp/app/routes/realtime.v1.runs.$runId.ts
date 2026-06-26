import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { resolveRealtimeStreamClient } from "~/services/realtime/resolveRealtimeStreamClient.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { runStore } from "~/v3/runStore.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) => {
      return runStore.findRun(
        {
          friendlyId: params.runId,
          runtimeEnvironmentId: authentication.environment.id,
        },
        {
          include: {
            batch: {
              select: {
                friendlyId: true,
              },
            },
          },
        },
        $replica
      );
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
  async ({ authentication, request, resource: run, apiVersion }) => {
    // Pick the Electric proxy or the native backend per org (defaults to Electric); both implement streamRun.
    const client = await resolveRealtimeStreamClient(authentication.environment);

    return client.streamRun(
      request.url,
      authentication.environment,
      run.id,
      apiVersion,
      authentication.realtime,
      request.headers.get("x-trigger-electric-version") ?? undefined,
      // Propagate abort on client disconnect so the upstream Electric long-poll is cancelled too, else undici buffers grow RSS until the poll timeout.
      getRequestAbortSignal()
    );
  }
);
