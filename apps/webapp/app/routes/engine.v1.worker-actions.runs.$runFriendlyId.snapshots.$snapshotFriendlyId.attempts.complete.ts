import { EngineServiceValidationError } from "@internal/run-engine";
import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import type { WorkerApiRunAttemptCompleteResponseBody } from "@trigger.dev/core/v3/workers";
import { WorkerApiRunAttemptCompleteRequestBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiRunAttemptCompleteRequestBody,
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    body,
    params,
    runnerId,
    environmentId,
  }): Promise<TypedResponse<WorkerApiRunAttemptCompleteResponseBody>> => {
    const { completion, forceRequeue } = body;
    const { runFriendlyId, snapshotFriendlyId } = params;

    const completeResult = await authenticatedWorker
      .completeRunAttempt({
        runFriendlyId,
        snapshotFriendlyId,
        completion,
        forceRequeue,
        runnerId,
        environmentId,
      })
      .catch((error) => {
        if (
          error instanceof EngineServiceValidationError &&
          error.metadata?.code === "SNAPSHOT_CONFLICT" &&
          typeof error.metadata.latestSnapshotId === "string"
        ) {
          // Stays a 400: the worker's client retries a 409, and a stale completion never applies.
          throw json(
            {
              error: error.message,
              code: error.metadata.code,
              latestSnapshotId: SnapshotId.toFriendlyId(error.metadata.latestSnapshotId),
            },
            { status: 400 }
          );
        }
        throw error;
      });

    return json({ result: completeResult });
  }
);
