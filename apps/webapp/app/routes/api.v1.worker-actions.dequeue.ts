import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiDequeueResponseBody } from "@trigger.dev/worker/schemas";
import { createLoaderWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {},
  async ({ authenticatedWorker }): Promise<TypedResponse<WorkerApiDequeueResponseBody>> => {
    return json(await authenticatedWorker.dequeue());
  }
);
