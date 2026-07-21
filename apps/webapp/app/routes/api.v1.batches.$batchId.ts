import { json } from "@remix-run/server-runtime";
import { z } from "zod";
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
      return runStore.findBatchTaskRunByFriendlyId(params.batchId, auth.environment.id, {
        include: { errors: true },
      });
    },
    authorization: {
      action: "read",
      // Pre-RBAC, this route's `superScopes` included `read:runs`, so a
      // JWT minted with `read:runs` could read batches. The new strict
      // scope-type match means `read:runs` no longer trivially matches
      // `{type: "batch"}`. Include `{type: "runs"}` (alongside the
      // batch-id-scoped element) to preserve that semantic for any
      // SDK-issued tokens in the wild — a `read:runs` JWT still passes
      // batch retrieval. Per-id `read:batch:<id>` and type-level
      // `read:batch` still grant via the first element.
      resource: (batch) => anyResource([{ type: "batch", id: batch.friendlyId }, { type: "runs" }]),
    },
  },
  async ({ resource: batch }) => {
    return json({
      id: batch.friendlyId,
      status: batch.status,
      idempotencyKey: batch.idempotencyKey ?? undefined,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      runCount: batch.runCount,
      runs: batch.runIds,
      // Include error details for PARTIAL_FAILED batches
      successfulRunCount: batch.successfulRunCount ?? undefined,
      failedRunCount: batch.failedRunCount ?? undefined,
      errors:
        batch.errors.length > 0
          ? batch.errors.map((err) => ({
              index: err.index,
              taskIdentifier: err.taskIdentifier,
              error: err.error,
              errorCode: err.errorCode ?? undefined,
            }))
          : undefined,
    });
  }
);
