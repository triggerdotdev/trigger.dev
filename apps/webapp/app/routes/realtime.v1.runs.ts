import { z } from "zod";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const SearchParamsSchema = z.object({
  tags: z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    }),
});

export const loader = createLoaderApiRoute(
  {
    searchParams: SearchParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (_, searchParams) => searchParams,
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ searchParams, authentication, request }) => {
    return realtimeClient.streamRuns(
      request.url,
      authentication.environment,
      searchParams,
      request.headers.get("x-trigger-electric-version") ?? undefined
    );
  }
);
