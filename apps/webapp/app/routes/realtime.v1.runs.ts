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
  createdAt: z.string().optional(),
});

export const loader = createLoaderApiRoute(
  {
    searchParams: SearchParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1, // This is a dummy value, it's not used
    authorization: {
      action: "read",
      resource: (_, __, searchParams) => searchParams,
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ searchParams, authentication, request }) => {
    return realtimeClient.streamRuns(
      request.url,
      authentication.environment,
      searchParams,
      authentication.realtime,
      request.headers.get("x-trigger-electric-version") ?? undefined
    );
  }
);
