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
      // See sibling note in api.v1.batches.$batchId.ts — `{type: "runs"}`
      // preserves pre-RBAC `read:runs` superScope access for batch reads.
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
      processingCompletedAt: batch.processingCompletedAt ?? undefined,
      runCount: batch.runCount,
      runs: batch.runIds,
      processing: {
        completedAt: batch.processingCompletedAt ?? undefined,
        errors:
          batch.errors.length > 0
            ? batch.errors.map((err) => ({
                index: err.index,
                taskIdentifier: err.taskIdentifier,
                error: err.error,
                errorCode: err.errorCode ?? undefined,
              }))
            : [],
      },
    });
  }
);
