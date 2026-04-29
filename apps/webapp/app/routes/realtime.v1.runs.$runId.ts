import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, authentication) => {
      return $replica.taskRun.findFirst({
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
  async ({ authentication, request, resource: run, apiVersion }) => {
    return realtimeClient.streamRun(
      request.url,
      authentication.environment,
      run.id,
      apiVersion,
      authentication.realtime,
      request.headers.get("x-trigger-electric-version") ?? undefined,
      // Propagate abort on client disconnect so the upstream Electric long-poll
      // fetch is cancelled too. Without this, undici buffers from the unconsumed
      // upstream response body accumulate until Electric's poll timeout, causing
      // steady RSS growth on api (see docs/runbooks for the H1 isolation test).
      getRequestAbortSignal()
    );
  }
);
