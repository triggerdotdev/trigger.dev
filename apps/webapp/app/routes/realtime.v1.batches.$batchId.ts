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
    // A just-created batch may not yet have replicated to the read replica this client-less
    // findBatchTaskRunByFriendlyId lookup routes to; return a retryable 404 so the SDK retries through
    // replica lag rather than stranding a live batch on a permanent 404 (mirrors the run-get routes,
    // e.g. api.v3.runs.$runId).
    shouldRetryNotFound: true,
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
