import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystemInstance.server";

const SearchParamsSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(100).default(25),
});

export const loader = createLoaderApiRoute(
  {
    searchParams: SearchParamsSchema,
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: () => ({ type: "queues" }),
    },
    corsStrategy: "all",
  },
  async ({ searchParams, authentication }) => {
    const [data, count] = await Promise.all([
      concurrencyLimitsSystem.limits.list(authentication.environment, {
        page: searchParams.page,
        perPage: searchParams.perPage,
      }),
      concurrencyLimitsSystem.limits.totalCount(authentication.environment),
    ]);

    if (data.isErr() || count.isErr()) {
      return json({ error: "Failed to list concurrency limits" }, { status: 500 });
    }

    return json({
      data: data.value,
      pagination: {
        currentPage: searchParams.page,
        totalPages: Math.ceil(count.value / searchParams.perPage),
        count: count.value,
      },
    });
  }
);
