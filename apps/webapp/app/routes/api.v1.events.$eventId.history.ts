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
      resource: (params) => ({ tasks: params.eventId }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
    findResource: async () => 1 as const,
  },
  async ({ params, authentication, request }) => {
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 200);
    const cursor = url.searchParams.get("cursor");
    const publisherRunId = url.searchParams.get("publisherRunId");

    const queryBuilder = clickhouseClient.eventLog.queryBuilder();

    queryBuilder
      .where("project_id = {projectId: String}", {
        projectId: authentication.environment.projectId,
      })
      .where("environment_id = {environmentId: String}", {
        environmentId: authentication.environment.id,
      })
      .where("event_type = {eventType: String}", {
        eventType: params.eventId,
      });

    if (from) {
      queryBuilder.where("published_at >= {from: DateTime64(3)}", { from });
    }

    if (to) {
      queryBuilder.where("published_at <= {to: DateTime64(3)}", { to });
    }

    if (publisherRunId) {
      queryBuilder.where("publisher_run_id = {publisherRunId: String}", { publisherRunId });
    }

    if (cursor) {
      queryBuilder.where("published_at < {cursor: DateTime64(3)}", { cursor });
    }

    queryBuilder.orderBy("published_at DESC, event_id DESC").limit(limit + 1);

    const [queryError, result] = await queryBuilder.execute();

    if (queryError) {
      return json({ error: "Failed to query event history" }, { status: 500 });
    }

    const hasMore = result.length > limit;
    const data = result.slice(0, limit);

    const lastItem = data[data.length - 1];
    const nextCursor = hasMore && lastItem ? lastItem.published_at : null;

    return json({
      data: data.map((row) => ({
        eventId: row.event_id,
        eventType: row.event_type,
        payload: safeParseJson(row.payload),
        publishedAt: row.published_at,
        publisherRunId: row.publisher_run_id || undefined,
        idempotencyKey: row.idempotency_key || undefined,
        tags: row.tags.length > 0 ? row.tags : undefined,
        fanOutCount: row.fan_out_count,
      })),
      pagination: {
        cursor: nextCursor,
        hasMore,
      },
    });
  }
);

function safeParseJson(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}
