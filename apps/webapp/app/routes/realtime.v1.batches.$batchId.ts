import { z } from "zod";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { resolveRealtimeStreamClient } from "~/services/realtime/resolveRealtimeStreamClient.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { runStore } from "~/v3/runStore.server";

const ParamsSchema = z.object({
  batchId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: (params, auth) => {
      return runStore.findBatchTaskRunByFriendlyId(params.batchId, auth.environment.id);
    },
    authorization: {
      action: "read",
      // See sibling note in api.v1.batches.$batchId.ts — `{type: "runs"}`
      // preserves pre-RBAC `read:runs` superScope access for batch reads.
      resource: (batch) => anyResource([{ type: "batch", id: batch.friendlyId }, { type: "runs" }]),
    },
  },
  async ({ authentication, request, resource: batchRun, apiVersion }) => {
    // Resolve the native realtime client; it implements streamBatch.
    const client = await resolveRealtimeStreamClient(authentication.environment);

    return client.streamBatch(
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
