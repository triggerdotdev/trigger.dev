import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const ParamsSchema = z.object({
  name: z.string().transform((val) => decodeURIComponent(val)),
});

const route = createActionApiRoute(
  {
    params: ParamsSchema,
    authorization: {
      action: "write",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ params, authentication }) => {
    return concurrencyLimitsSystem.limits.reset(authentication.environment, params.name).match(
      (limit) => json(limit),
      (error) => {
        switch (error.type) {
          case "limit_not_found":
            return json({ error: "Concurrency limit not found" }, { status: 404 });
          case "conflict":
            return json(
              { error: "The limit changed concurrently; retry the request" },
              { status: 409 }
            );
          case "limit_not_overridden":
            return json({ error: "Concurrency limit has no override to reset" }, { status: 400 });
          default:
            return json({ error: "Failed to reset concurrency limit" }, { status: 500 });
        }
      }
    );
  }
);

export const action = route.action;
export const loader = route.loader;
