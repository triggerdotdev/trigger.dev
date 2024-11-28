import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkloadHeartbeatResponseBody } from "@trigger.dev/worker/schemas";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

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
  }): Promise<TypedResponse<WorkloadHeartbeatResponseBody>> => {
    const { runId, snapshotId } = params;

    await authenticatedWorker.heartbeatRun({
      runId,
      snapshotId,
    });

    return json({ ok: true });
  }
);
