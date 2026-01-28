import { type ApiResult, wrapZodFetch } from "@trigger.dev/core/v3/zodfetch";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { createLRUMemoryStore } from "@internal/cache";
import { z } from "zod";
import { env } from "~/env.server";

const IncidentSchema = z.object({
  data: z.object({
    id: z.string(),
    type: z.string(),
    attributes: z.object({
      aggregate_state: z.string(),
    }),
  }),
});

export type Incident = z.infer<typeof IncidentSchema>;

const ctx = new DefaultStatefulContext();
const memory = createLRUMemoryStore(100);

const cache = createCache({
  query: new Namespace<ApiResult<Incident>>(ctx, {
    stores: [memory],
    fresh: 15_000,
    stale: 30_000,
  }),
});

export class BetterStackClient {
  private readonly baseUrl = "https://uptime.betterstack.com/api/v2";

  async getIncidents() {
    const apiKey = env.BETTERSTACK_API_KEY;
    if (!apiKey) {
      return { success: false as const, error: "BETTERSTACK_API_KEY is not set" };
    }

    const statusPageId = env.BETTERSTACK_STATUS_PAGE_ID;
    if (!statusPageId) {
      return { success: false as const, error: "BETTERSTACK_STATUS_PAGE_ID is not set" };
    }

    const cachedResult = await cache.query.swr("betterstack", async () => {
      try {
        const result = await wrapZodFetch(
          IncidentSchema,
          `${this.baseUrl}/status-pages/${statusPageId}`,
          {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "Content-Type": "application/json",
            },
          },
          {
            retry: {
              maxAttempts: 3,
              minTimeoutInMs: 1000,
              maxTimeoutInMs: 5000,
            },
          }
        );

        return result;
      } catch (error) {
        console.error("Failed to fetch incidents from BetterStack:", error);
        return {
          success: false as const,
          error: error instanceof Error ? error.message : "Unknown error",
        };
      }
    });

    if (cachedResult.err) {
      return { success: false as const, error: cachedResult.err };
    }

    if (!cachedResult.val) {
      return { success: false as const, error: "No result from BetterStack" };
    }

    if (!cachedResult.val.success) {
      return { success: false as const, error: cachedResult.val.error };
    }

    return { success: true as const, data: cachedResult.val.data.data };
  }
}
