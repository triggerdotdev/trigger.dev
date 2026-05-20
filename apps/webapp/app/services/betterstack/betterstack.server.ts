import { wrapZodFetch } from "@trigger.dev/core/v3/zodfetch";
import { createCache, DefaultStatefulContext, Namespace } from "@unkey/cache";
import { createLRUMemoryStore } from "@internal/cache";
import { z } from "zod";
import { env } from "~/env.server";

const StatusPageSchema = z.object({
  data: z.object({
    id: z.string(),
    type: z.string(),
    attributes: z.object({
      aggregate_state: z.enum(["operational", "degraded", "downtime"]),
    }),
  }),
});

const StatusReportsSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      type: z.literal("status_report"),
      attributes: z.object({
        title: z.string().nullable(),
        starts_at: z.string().nullable(),
        ends_at: z.string().nullable(),
        aggregate_state: z.string().nullable(),
      }),
    })
  ),
  pagination: z.object({
    first: z.string().nullable(),
    last: z.string().nullable(),
    prev: z.string().nullable(),
    next: z.string().nullable(),
  }),
});

export type AggregateState = "operational" | "degraded" | "downtime";

export type IncidentStatus = {
  status: AggregateState;
  title: string | null;
};

type CachedResult =
  | { success: true; data: IncidentStatus }
  | { success: false; error: unknown };

const ctx = new DefaultStatefulContext();
const memory = createLRUMemoryStore(100);

const cache = createCache({
  query: new Namespace<CachedResult>(ctx, {
    stores: [memory],
    fresh: 15_000,
    stale: 30_000,
  }),
});

export class BetterStackClient {
  private readonly baseUrl = "https://uptime.betterstack.com/api/v2";

  async getIncidentStatus(): Promise<CachedResult> {
    const apiKey = env.BETTERSTACK_API_KEY;
    const statusPageId = env.BETTERSTACK_STATUS_PAGE_ID;

    if (!apiKey || !statusPageId) {
      return { success: false, error: "Missing BetterStack configuration" };
    }

    const cachedResult = await cache.query.swr("betterstack-incident-status", () =>
      this.fetchIncidentStatus(apiKey, statusPageId)
    );

    if (cachedResult.err || !cachedResult.val) {
      return { success: false, error: cachedResult.err ?? "No result from cache" };
    }

    return cachedResult.val;
  }

  private async fetchIncidentStatus(
    apiKey: string,
    statusPageId: string
  ): Promise<CachedResult> {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const retryConfig = {
      retry: { maxAttempts: 3, minTimeoutInMs: 1000, maxTimeoutInMs: 5000 },
    };

    try {
      // Fetch the status page to get aggregate state
      const statusPageResult = await wrapZodFetch(
        StatusPageSchema,
        `${this.baseUrl}/status-pages/${statusPageId}`,
        { headers },
        retryConfig
      );

      if (!statusPageResult.success) {
        return { success: false, error: statusPageResult.error };
      }

      const status = statusPageResult.data.data.attributes.aggregate_state;

      // If operational, no need to fetch reports
      if (status === "operational") {
        return { success: true, data: { status, title: null } };
      }

      // Fetch status reports to get the incident title
      const title = await this.fetchActiveReportTitle(apiKey, statusPageId, headers, retryConfig);

      return { success: true, data: { status, title } };
    } catch (error) {
      console.error("Failed to fetch incident status from BetterStack:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private async fetchActiveReportTitle(
    apiKey: string,
    statusPageId: string,
    headers: Record<string, string>,
    retryConfig: { retry: { maxAttempts: number; minTimeoutInMs: number; maxTimeoutInMs: number } }
  ): Promise<string | null> {
    const reportsUrl = `${this.baseUrl}/status-pages/${statusPageId}/status-reports`;

    let reportsResult = await wrapZodFetch(
      StatusReportsSchema,
      reportsUrl,
      { headers },
      retryConfig
    );

    if (!reportsResult.success) {
      return null;
    }

    // Fetch last page if there are multiple pages (most recent reports are at the end)
    const { first, last } = reportsResult.data.pagination;
    if (last && last !== first) {
      const lastPageResult = await wrapZodFetch(
        StatusReportsSchema,
        last,
        { headers },
        retryConfig
      );
      if (lastPageResult.success) {
        reportsResult = lastPageResult;
      }
    }

    // Find active reports (not resolved, not ended)
    const activeReports = reportsResult.data.data.filter(
      (report) =>
        report.attributes.aggregate_state !== "resolved" && report.attributes.ends_at === null
    );

    if (activeReports.length === 0) {
      return null;
    }

    // Return the title from the most recent active report
    const mostRecent = activeReports[activeReports.length - 1];
    return mostRecent.attributes.title;
  }
}
