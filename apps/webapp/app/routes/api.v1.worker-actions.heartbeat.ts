import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiHeartbeatResponseBody, WorkerApiHeartbeatRequestBody } from "@trigger.dev/worker";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiHeartbeatRequestBody,
  },
  async ({ authenticatedWorker }): Promise<TypedResponse<WorkerApiHeartbeatResponseBody>> => {
    await authenticatedWorker.heartbeatWorkerInstance();
    return json({ ok: true });
  }
);
