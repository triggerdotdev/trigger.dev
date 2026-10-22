import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const ParamsSchema = z.object({
  name: z.string(),
});

const SearchParamsSchema = z.object({
  concurrencyKey: z.string().min(1).max(128).optional(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    searchParams: SearchParamsSchema,
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ params, searchParams, authentication }) => {
    const result =
      searchParams.concurrencyKey !== undefined
        ? concurrencyLimitsSystem.limits.retrieveKey(
            authentication.environment,
            params.name,
            searchParams.concurrencyKey
          )
        : concurrencyLimitsSystem.limits.retrieve(authentication.environment, params.name);
    return result.match(
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
