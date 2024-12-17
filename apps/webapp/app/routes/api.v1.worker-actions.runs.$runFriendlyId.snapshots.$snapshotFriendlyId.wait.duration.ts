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
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    body,
    params,
  }): Promise<TypedResponse<WorkerApiWaitForDurationResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    const waitResult = await authenticatedWorker.waitForDuration({
      runFriendlyId,
      snapshotFriendlyId,
      date: body.date,
    });

    return json(waitResult);
  }
);
