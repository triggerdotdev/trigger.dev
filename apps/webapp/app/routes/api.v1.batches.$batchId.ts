import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
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
        include: {
          errors: true,
        },
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
      resource: (batch) =>
        anyResource([
          { type: "batch", id: batch.friendlyId },
          { type: "runs" },
        ]),
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
