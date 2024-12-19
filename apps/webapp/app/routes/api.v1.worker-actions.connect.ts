import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiConnectRequestBody,
  WorkerApiConnectResponseBody,
} from "@trigger.dev/worker";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiConnectRequestBody,
  },
  async ({ authenticatedWorker, body }): Promise<TypedResponse<WorkerApiConnectResponseBody>> => {
    await authenticatedWorker.connect(body.metadata);
    return json({ ok: true });
  }
);
