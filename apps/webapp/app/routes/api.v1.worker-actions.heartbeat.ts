import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiConnectResponseBody,
  WorkerApiHeartbeatRequestBody,
} from "@trigger.dev/worker/schemas";
import { createActionWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    body: WorkerApiHeartbeatRequestBody,
  },
  async ({ authenticatedWorker }): Promise<TypedResponse<WorkerApiConnectResponseBody>> => {
    await authenticatedWorker.heartbeatWorkerInstance();
    return json({ ok: true });
  }
);
