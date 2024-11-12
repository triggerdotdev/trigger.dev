import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiConnectResponseBody } from "@trigger.dev/worker/schemas";
import { createLoaderWorkerApiRoute } from "~/services/routeBuiilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {},
  async ({ authenticatedWorker }): Promise<TypedResponse<WorkerApiConnectResponseBody>> => {
    return json({ ok: true });
  }
);
