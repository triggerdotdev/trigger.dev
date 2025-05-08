import { wrapZodFetch } from "@trigger.dev/core/v3/zodfetch";
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

    try {
      return await wrapZodFetch(
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
    } catch (error) {
      console.error("Failed to fetch incidents from BetterStack:", error);
      return { success: false as const, error };
    }
  }
}
