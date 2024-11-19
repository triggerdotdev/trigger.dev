import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (params) => ({ runs: params.runId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ params, authentication, request }) => {
    const run = await $replica.taskRun.findFirst({
      where: {
        friendlyId: params.runId,
        runtimeEnvironmentId: authentication.environment.id,
      },
    });

    if (!run) {
      return json({ error: "Run not found" }, { status: 404 });
    }

    return realtimeClient.streamRun(
      request.url,
      authentication.environment,
      run.id,
      request.headers.get("x-trigger-electric-version") ?? undefined
    );
  }
);
