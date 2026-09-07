import { json } from "@remix-run/server-runtime";
import { OverrideConcurrencyLimitRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const ParamsSchema = z.object({
  name: z.string().transform((val) => decodeURIComponent(val)),
});

const route = createActionApiRoute(
  {
    params: ParamsSchema,
    body: OverrideConcurrencyLimitRequestBody,
    authorization: {
      action: "write",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ params, body, authentication }) => {
    return concurrencyLimitsSystem.limits
      .override(authentication.environment, params.name, body)
      .match(
        (limit) => json(limit),
        (error) => {
          switch (error.type) {
            case "limit_not_found":
              return json({ error: "Concurrency limit not found" }, { status: 404 });
            case "invalid_override":
              return json({ error: error.message }, { status: 400 });
            default:
              return json({ error: "Failed to override concurrency limit" }, { status: 500 });
          }
        }
      );
  }
);

export const action = route.action;
export const loader = route.loader;
