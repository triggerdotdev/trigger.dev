import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiDequeueRequestBody,
  WorkerApiDequeueResponseBody,
} from "@trigger.dev/core/v3/workers";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiDequeueRequestBody, // Even though we don't use it, we need to keep it for backwards compatibility
  },
  async ({
    authenticatedWorker,
    runnerId,
  }): Promise<TypedResponse<WorkerApiDequeueResponseBody>> => {
    return json(await authenticatedWorker.dequeue({ runnerId }));
  }
);
