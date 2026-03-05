import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    corsStrategy: "all",
    authorization: {
      action: "read",
      resource: (_resource, params) => ({ tasks: params.eventId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
    findResource: async () => 1 as const,
  },
  async ({ params, authentication, request }) => {
    const url = new URL(request.url);
    const period = url.searchParams.get("period") ?? "24h";

    // SAFETY: interval is NOT user input — it comes from a closed allowlist below.
    // Invalid periods are rejected with 400 before the value is used in the query.
    // This is safe from SQL injection because only hardcoded strings can reach the query.
    const intervalMap: Record<string, string> = {
      "1h": "1 HOUR",
      "6h": "6 HOUR",
      "24h": "24 HOUR",
      "7d": "7 DAY",
      "30d": "30 DAY",
    };

    const interval = intervalMap[period];
    if (!interval) {
      return json(
        { error: `Invalid period "${period}". Use: 1h, 6h, 24h, 7d, 30d` },
        { status: 400 }
      );
    }

    const queryBuilder = clickhouseClient.eventCounts.queryBuilder();

    queryBuilder
      .where("project_id = {projectId: String}", {
        projectId: authentication.environment.projectId,
      })
      .where("environment_id = {environmentId: String}", {
        environmentId: authentication.environment.id,
      })
      .where("event_type = {eventType: String}", {
        eventType: params.eventId,
      })
      .where(`bucket_start >= now() - INTERVAL ${interval}`)
      .orderBy("bucket_start ASC");

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      return json({ error: "Failed to query event stats" }, { status: 500 });
    }

    let totalEventCount = 0;
    let totalFanOut = 0;

    const buckets = result.map((row) => {
      totalEventCount += row.event_count;
      totalFanOut += row.total_fan_out;

      return {
        timestamp: row.bucket_start,
        eventCount: row.event_count,
        fanOutCount: row.total_fan_out,
      };
    });

    return json({
      eventType: params.eventId,
      period,
      buckets,
      totals: {
        eventCount: totalEventCount,
        fanOutCount: totalFanOut,
      },
    });
  }
);
