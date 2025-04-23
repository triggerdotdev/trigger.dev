import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiDequeueRequestBody,
  WorkerApiDequeueResponseBody,
} from "@trigger.dev/core/v3/workers";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiDequeueRequestBody,
  },
  async ({ authenticatedWorker, body }): Promise<TypedResponse<WorkerApiDequeueResponseBody>> => {
    return json(
      await authenticatedWorker.dequeue({
        maxResources: body.maxResources,
        maxRunCount: body.maxRunCount,
      })
    );
  }
);
