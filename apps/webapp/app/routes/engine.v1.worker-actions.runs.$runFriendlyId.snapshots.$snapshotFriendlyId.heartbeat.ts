import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  WorkerApiRunHeartbeatRequestBody,
  type WorkerApiRunHeartbeatResponseBody,
} from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

// Older supervisors send no body fields this route reads; anything unparseable is ignored.
const HeartbeatBody = WorkerApiRunHeartbeatRequestBody.catch({});

export const action = createActionWorkerApiRoute(
  {
    body: HeartbeatBody,
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
  }): Promise<TypedResponse<WorkerApiRunHeartbeatResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    const { runToken } = await authenticatedWorker.heartbeatRun({
      runFriendlyId,
      snapshotFriendlyId,
      runnerId,
      environmentId,
      runTokenReport: body.runToken,
    });

    return json({ ok: true, runToken });
  }
);
