import { z } from "zod";
import { $replica } from "~/db.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  batchId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: (params, auth) => {
      return $replica.batchTaskRun.findFirst({
        where: {
          friendlyId: params.batchId,
          runtimeEnvironmentId: auth.environment.id,
        },
      });
    },
    authorization: {
      action: "read",
      resource: (batch) => ({ batch: batch.friendlyId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ authentication, request, resource: batchRun }) => {
    return realtimeClient.streamBatch(
      request.url,
      authentication.environment,
      batchRun.id,
      authentication.realtime,
      request.headers.get("x-trigger-electric-version") ?? undefined
    );
  }
);
