import { z } from "zod";
import { getRequestAbortSignal } from "~/services/httpAsyncStorage.server";
import { resolveRealtimeStreamClient } from "~/services/realtime/resolveRealtimeStreamClient.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { UNSAFE_REALTIME_TAG_CHARS } from "~/v3/electricShape.server";

const SearchParamsSchema = z.object({
  tags: z
    .string()
    .optional()
    .transform((value) => {
      return value ? value.split(",") : undefined;
    })
    .superRefine((tags, ctx) => {
      if (!tags) return;
      for (const tag of tags) {
        // Mirror the runtime sanitiser's reject list so the API returns 400
        // instead of a 500. Single quotes are allowed — escaped downstream.
        if (UNSAFE_REALTIME_TAG_CHARS.test(tag) || tag.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Invalid tag: ${JSON.stringify(tag)}`,
          });
          return;
        }
      }
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
    // Resolve the native realtime client; it implements streamRuns.
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
