import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptCompleteResponseBody,
} from "@trigger.dev/worker/schemas";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiRunAttemptCompleteRequestBody,
    params: z.object({
      runId: z.string(),
      snapshotId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    body,
    params,
  }): Promise<TypedResponse<WorkerApiRunAttemptCompleteResponseBody>> => {
    const { completion } = body;
    const { runId, snapshotId } = params;

    const completeResult = await authenticatedWorker.completeRunAttempt({
      runId,
      snapshotId,
      completion,
    });

    return json({ result: completeResult });
  }
);
