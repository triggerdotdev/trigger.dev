import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiRunAttemptStartResponseBody } from "@trigger.dev/worker/schemas";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    params: z.object({
      runId: z.string(),
      snapshotId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    params,
  }): Promise<TypedResponse<WorkerApiRunAttemptStartResponseBody>> => {
    const { runId, snapshotId } = params;

    const runExecutionData = await authenticatedWorker.startRunAttempt({
      runId,
      snapshotId,
    });

    return json(runExecutionData);
  }
);
