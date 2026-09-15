import { z } from "zod";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { resolveRealtimeStreamClient } from "~/services/realtime/resolveRealtimeStreamClient.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveBatchTaskRunForRealtime } from "~/v3/realtime/resolveBatchForRealtime.server";

const ParamsSchema = z.object({
  batchId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    // A just-created batch may not yet have replicated to the read replica the client-less lookup uses.
    // shouldRetryNotFound stamps a retryable 404 for the zodfetch GET; the realtime resolver ALSO
    // re-reads the owning primary on a replica miss, so the Electric ShapeStream consumer (which ignores
    // x-should-retry) doesn't strand a live batch on a permanent 404. Mirrors the run-get routes.
    shouldRetryNotFound: true,
    findResource: (params, auth) =>
      resolveBatchTaskRunForRealtime(params.batchId, auth.environment.id),
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
