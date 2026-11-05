import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
  },
  async ({ authenticatedWorker, params, environmentId }) => {
    const authorizedEnvironmentId = await authenticatedWorker.authorizeSuspend(
      params.runFriendlyId,
      environmentId
    );
    return json({ ok: true, environmentId: authorizedEnvironmentId });
  }
);
