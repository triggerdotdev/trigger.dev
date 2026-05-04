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
        anyResource([
          { type: "runs" },
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
