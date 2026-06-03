import { tool } from "ai";
import { aggregateRuns as aggregateRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import {
  buildTimeRange,
  formatClickhouseTimestamp,
  CLICKHOUSE_QUERY_SETTINGS,
} from "./clickhouse-queries";

export function createAggregateRunsTool(ctx: ToolContext) {
  return tool({
    ...aggregateRunsSchema,
    execute: async (params: { groupBy: string; metric?: string; period?: string }) => {
      try {
        const { clickhouseClient } = await import("~/v3/clickhouse.server");
        const { prisma } = await import("~/db.server");

        // Validate groupBy parameter
        if (!["task", "status", "version", "queue"].includes(params.groupBy)) {
          return {
            error: "Invalid groupBy parameter. Must be one of: task, status, version, queue",
            results: [],
          };
        }

        // Get environment IDs
        const environment = await prisma.runtimeEnvironment.findFirst({
          where: {
            slug: ctx.clientData.environmentSlug,
            project: {
              slug: ctx.clientData.projectSlug,
            },
          },
          select: {
            id: true,
            organizationId: true,
            project: {
              select: {
                id: true,
              },
            },
          },
        });

        if (!environment) {
          return {
            error: "Environment not found",
            results: [],
          };
        }

        const { from, to } = buildTimeRange(params.period);
        const metric = params.metric || "count";

        // Map groupBy to column names
        const columnMap: Record<string, string> = {
          task: "task_identifier",
          status: "status",
          version: "deployment_version",
          queue: "queue_name",
        };

        const groupColumn = columnMap[params.groupBy];

        // Build metric aggregate
        let metricSelect = "COUNT(*) as count";
        if (metric === "failureRate") {
          metricSelect = `
            ROUND(
              SUM(CASE WHEN status IN ('COMPLETED_WITH_ERRORS', 'CRASHED', 'TIMED_OUT') THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
              2
            ) as failure_rate_percent
          `;
        } else if (metric === "avgDuration") {
          metricSelect = `ROUND(AVG(duration_ms), 0) as avg_duration_ms`;
        } else if (metric === "p95Duration") {
          metricSelect = `ROUND(quantile(0.95)(duration_ms), 0) as p95_duration_ms`;
        }

        const query = `
          SELECT
            ${groupColumn} as dimension,
            ${metricSelect}
          FROM trigger_dev.task_runs_v2
          WHERE
            organization_id = '${environment.organizationId}'
            AND project_id = '${environment.project.id}'
            AND environment_id = '${environment.id}'
            AND engine = 'V2'
            AND triggered_at >= '${formatClickhouseTimestamp(from)}'
            AND triggered_at < '${formatClickhouseTimestamp(to)}'
          GROUP BY ${groupColumn}
          ORDER BY count DESC
          LIMIT 50
          SETTINGS max_execution_time = ${CLICKHOUSE_QUERY_SETTINGS.max_execution_time}
        `;

        const results = await clickhouseClient.query({
          query,
          format: "JSONCompact",
        });

        const parsed = JSON.parse(results.text);
        const formattedResults = parsed.data?.map((row: unknown[]) => ({
          dimension: row[0],
          value: row[1],
        })) || [];

        return {
          groupBy: params.groupBy,
          metric,
          results: formattedResults,
        };
      } catch (error) {
        return {
          error: `Failed to aggregate runs: ${error instanceof Error ? error.message : String(error)}`,
          results: [],
        };
      }
    },
  });
}
