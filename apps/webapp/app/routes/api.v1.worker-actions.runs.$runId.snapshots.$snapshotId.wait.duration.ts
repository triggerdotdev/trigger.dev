import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiWaitForDurationRequestBody,
  WorkerApiWaitForDurationResponseBody,
} from "@trigger.dev/worker";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiWaitForDurationRequestBody,
    params: z.object({
      runId: z.string(),
      snapshotId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    body,
    params,
  }): Promise<TypedResponse<WorkerApiWaitForDurationResponseBody>> => {
    const { runId, snapshotId } = params;

    const waitResult = await authenticatedWorker.waitForDuration({
      runId,
      snapshotId,
      date: body.date,
    });

    return json(waitResult);
  }
);
