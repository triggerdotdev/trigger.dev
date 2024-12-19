import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiConnectResponseBody,
  WorkerApiHeartbeatRequestBody,
} from "@trigger.dev/worker";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiHeartbeatRequestBody,
  },
  async ({ authenticatedWorker }): Promise<TypedResponse<WorkerApiConnectResponseBody>> => {
    await authenticatedWorker.heartbeatWorkerInstance();
    return json({ ok: true });
  }
);
