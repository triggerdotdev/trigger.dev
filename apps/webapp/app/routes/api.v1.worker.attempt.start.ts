import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const loader = createActionWorkerApiRoute(
  {
    body: z.object({
      runId: z.string(),
      snapshotId: z.string(),
    }),
  },
  async ({ authenticatedWorker, body }) => {
    const { runId, snapshotId } = body;
    const runExecutionData = await authenticatedWorker.startRunAttempt({ runId, snapshotId });
    return json(runExecutionData);
  }
);
