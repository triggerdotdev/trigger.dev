import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { WorkerApiDequeueResponseBody } from "@trigger.dev/core/v3/workers";
import { WorkerApiDequeueRequestBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: z.compile(WorkerApiDequeueRequestBody),
    bodyValidationErrorStatus: (error) =>
      error.issues.every((issue) => issue.path[0] === "subscriptions") ? 422 : 400,
  },
  async ({
    authenticatedWorker,
    runnerId,
    body,
  }): Promise<TypedResponse<WorkerApiDequeueResponseBody>> => {
    return json(
      await authenticatedWorker.dequeue({
        runnerId,
        queueClass: body.queueClass,
        subscriptions: body.subscriptions,
      })
    );
  }
);
