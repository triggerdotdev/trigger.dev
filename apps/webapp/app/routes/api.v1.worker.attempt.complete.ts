import { json } from "@remix-run/server-runtime";
import { TaskRunExecutionResult } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const loader = createActionWorkerApiRoute(
  {
    body: z.object({
      runId: z.string(),
      snapshotId: z.string(),
      completion: TaskRunExecutionResult,
    }),
  },
  async ({ authenticatedWorker, body }) => {
    const { runId, snapshotId, completion } = body;
    const completeResult = await authenticatedWorker.completeRunAttempt({
      runId,
      snapshotId,
      completion,
    });
    return json({ completeResult });
  }
);
