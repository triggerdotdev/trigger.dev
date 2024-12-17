import { z } from "zod";
import { $replica } from "~/db.server";
import {
  createActionApiRoute,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { v2RealtimeStreams } from "~/services/realtime/v2StreamsGlobal.server";

const ParamsSchema = z.object({
  runId: z.string(),
  streamId: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
  },
  async ({ request, params, authentication }) => {
    if (!request.body) {
      return new Response("No body provided", { status: 400 });
    }

    const run = await $replica.taskRun.findFirst({
      where: {
        friendlyId: params.runId,
        runtimeEnvironmentId: authentication.environment.id,
      },
      include: {
        batch: {
          select: {
            friendlyId: true,
          },
        },
      },
    });

    if (!run) {
      return new Response("Run not found", { status: 404 });
    }

    return v2RealtimeStreams.ingestData(request.body, run.id, params.streamId);
  }
);

export { action };

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
    return v2RealtimeStreams.streamResponse(
      request,
      run.id,
      params.streamId,
      authentication.environment,
      request.signal
    );
  }
);
