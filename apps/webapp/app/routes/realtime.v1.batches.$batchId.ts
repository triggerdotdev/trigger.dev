import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  batchId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (params) => ({ batch: params.batchId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ params, authentication, request }) => {
    const batchRun = await $replica.batchTaskRun.findFirst({
      where: {
        friendlyId: params.batchId,
        runtimeEnvironmentId: authentication.environment.id,
      },
    });

    if (!batchRun) {
      return json({ error: "Batch not found" }, { status: 404 });
    }

    return realtimeClient.streamBatch(
      request.url,
      authentication.environment,
      batchRun.id,
      request.headers.get("x-trigger-electric-version") ?? undefined
    );
  }
);
