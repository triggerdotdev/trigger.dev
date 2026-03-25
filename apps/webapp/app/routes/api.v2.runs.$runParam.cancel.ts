import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { CancelTaskRunService } from "~/v3/services/cancelTaskRun.server";

const ParamsSchema = z.object({
  runParam: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "none",
    authorization: {
      action: "write",
      resource: (params) => ({ runs: params.runParam }),
      superScopes: ["write:runs", "admin"],
    },
    findResource: async (params, auth) => {
      return $replica.taskRun.findFirst({
        where: {
          friendlyId: params.runParam,
          runtimeEnvironmentId: auth.environment.id,
        },
      });
    },
  },
  async ({ resource }) => {
    if (!resource) {
      return json({ error: "Run not found" }, { status: 404 });
    }

    const service = new CancelTaskRunService();

    try {
      await service.call(resource);
    } catch (error) {
      return json({ error: "Internal Server Error" }, { status: 500 });
    }

    return json({ id: resource.friendlyId }, { status: 200 });
  }
);

export { action };
