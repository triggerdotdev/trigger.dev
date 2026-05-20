import { z } from "zod";
import { $replica } from "~/db.server";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

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
      // See sibling note in api.v1.batches.$batchId.ts — `{type: "runs"}`
      // preserves pre-RBAC `read:runs` superScope access for batch reads.
      resource: (batch) =>
        anyResource([
          { type: "batch", id: batch.friendlyId },
          { type: "runs" },
        ]),
    },
  },
  async ({ authentication, request, resource: batchRun, apiVersion }) => {
    return realtimeClient.streamBatch(
      request.url,
      authentication.environment,
      batchRun.id,
      apiVersion,
      authentication.realtime,
      request.headers.get("x-trigger-electric-version") ?? undefined,
      getRequestAbortSignal()
    );
  }
);
