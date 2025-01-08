import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptCompleteResponseBody,
} from "@trigger.dev/core/v3/workers";
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
  }): Promise<TypedResponse<WorkerApiRunAttemptCompleteResponseBody>> => {
    const { completion } = body;
    const { runFriendlyId, snapshotFriendlyId } = params;

    const completeResult = await authenticatedWorker.completeRunAttempt({
      runFriendlyId,
      snapshotFriendlyId,
      completion,
    });

    return json({ result: completeResult });
  }
);
