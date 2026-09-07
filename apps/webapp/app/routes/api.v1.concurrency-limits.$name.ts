import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const ParamsSchema = z.object({
  name: z.string().transform((val) => decodeURIComponent(val)),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ params, authentication }) => {
    return concurrencyLimitsSystem.limits.retrieve(authentication.environment, params.name).match(
      (limit) => json(limit),
      (error) => {
        if (error.type === "limit_not_found") {
          return json({ error: "Concurrency limit not found" }, { status: 404 });
        }
        return json({ error: "Failed to retrieve concurrency limit" }, { status: 500 });
      }
    );
  }
);
