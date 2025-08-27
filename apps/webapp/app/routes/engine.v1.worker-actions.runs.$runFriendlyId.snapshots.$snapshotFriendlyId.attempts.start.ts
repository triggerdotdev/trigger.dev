import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiRunAttemptStartRequestBody,
  WorkerApiRunAttemptStartResponseBody,
} from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiRunAttemptStartRequestBody,
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
  }): Promise<TypedResponse<WorkerApiRunAttemptStartResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    const runExecutionData = await authenticatedWorker.startRunAttempt({
      runFriendlyId,
      snapshotFriendlyId,
      isWarmStart: body.isWarmStart,
      runnerId,
    });

    return json(runExecutionData);
  }
);
