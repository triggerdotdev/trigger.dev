import { z } from "zod";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { resolveRealtimeStreamClient } from "~/services/realtime/resolveRealtimeStreamClient.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

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
      resource: (_, __, searchParams) =>
        // `{ type: "tags" }` preserves pre-RBAC type-level `read:tags` access to the unfiltered stream; per-id `read:tags:<tag>` still grants only when the filter includes that tag.
        anyResource([
          { type: "runs" },
          { type: "tags" },
          ...(searchParams.tags ?? []).map((tag) => ({ type: "tags", id: tag })),
        ]),
    },
  },
  async ({ searchParams, authentication, request, apiVersion }) => {
    // Pick the Electric proxy or the native backend per org (defaults to Electric); both implement streamRuns.
    const client = await resolveRealtimeStreamClient(authentication.environment);

    return client.streamRuns(
      request.url,
      authentication.environment,
      searchParams,
      apiVersion,
      authentication.realtime,
      request.headers.get("x-trigger-electric-version") ?? undefined,
      getRequestAbortSignal()
    );
  }
);
