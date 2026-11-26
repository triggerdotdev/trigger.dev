import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { isPendingUnitInProgress } from "@internal/run-store";
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
    sandboxRunId,
  }): Promise<TypedResponse<WorkerApiRunHeartbeatResponseBody | { error: string }>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    let heartbeat: Awaited<ReturnType<typeof authenticatedWorker.heartbeatRun>>;
    try {
      heartbeat = await authenticatedWorker.heartbeatRun({
        runFriendlyId,
        snapshotFriendlyId,
        runnerId,
        environmentId,
        sandboxRunId,
        runTokenReport: body.runToken,
        usageJwtReport: body.usageJwt,
      });
    } catch (error) {
      // Returned, not thrown: the route builder logs every thrown value as an error. The engine has
      // already extended the heartbeat and logged a warn; other retriable reasons stay errors.
      if (isPendingUnitInProgress(error)) {
        return json({ error: "Snapshot read temporarily unavailable" }, { status: 503 });
      }
      throw error;
    }

    const { runToken, usageJwt, usageJwtError } = heartbeat;
    return json({ ok: true, runToken, usageJwt, usageJwtError });
  }
);
