import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
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
        include: {
          errors: true,
        },
      });
    },
    authorization: {
      action: "read",
      resource: (batch) => ({ batch: batch.friendlyId }),
      superScopes: ["read:runs", "read:all", "admin"],
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
