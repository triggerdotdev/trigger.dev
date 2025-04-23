import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkloadHeartbeatResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    params,
  }): Promise<TypedResponse<WorkloadHeartbeatResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    await authenticatedWorker.heartbeatRun({
      runFriendlyId,
      snapshotFriendlyId,
    });

    return json({ ok: true });
  }
);
