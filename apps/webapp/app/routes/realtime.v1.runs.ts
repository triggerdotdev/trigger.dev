import { z } from "zod";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import {
  anyResource,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";

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
        // Pre-RBAC, the resource was the searchParams object itself and
        // the legacy `checkAuthorization` iterated `Object.keys`, so a
        // JWT with type-level `read:tags` (no id) granted access to the
        // unfiltered runs stream. Including `{ type: "tags" }` here
        // preserves that — per-id `read:tags:<tag>` still grants only
        // when the filter includes that tag.
        anyResource([
          { type: "runs" },
          { type: "tags" },
          ...(searchParams.tags ?? []).map((tag) => ({ type: "tags", id: tag })),
        ]),
    },
  },
  async ({ searchParams, authentication, request, apiVersion }) => {
    return realtimeClient.streamRuns(
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
