import { tool } from "ai";
import { summarizeCurrentView as summarizeCurrentViewSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import {
  buildTimeRange,
  formatClickhouseTimestamp,
  CLICKHOUSE_QUERY_SETTINGS,
} from "./clickhouse-queries";

export function createSummarizeCurrentViewTool(ctx: ToolContext) {
  return tool({
    ...summarizeCurrentViewSchema,
    execute: async (params: { period?: string }) => {
      try {
        const { clickhouseClient } = await import("~/v3/clickhouse.server");
        const { prisma } = await import("~/db.server");

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
            totalRuns: 0,
            statusDistribution: {},
            topFailingTasks: [],
            errorRate: "0%",
          };
        }

        const { from, to } = buildTimeRange(params.period);

        // Query 1: Total runs and status distribution
        const statusQuery = `
          SELECT
            status,
            COUNT(*) as count
          FROM trigger_dev.task_runs_v2
          WHERE
            organization_id = '${environment.organizationId}'
            AND project_id = '${environment.project.id}'
            AND environment_id = '${environment.id}'
            AND engine = 'V2'
            AND triggered_at >= '${formatClickhouseTimestamp(from)}'
            AND triggered_at < '${formatClickhouseTimestamp(to)}'
          GROUP BY status
          SETTINGS max_execution_time = ${CLICKHOUSE_QUERY_SETTINGS.max_execution_time}
        `;

        const statusResults = await clickhouseClient.query({
          query: statusQuery,
          format: "JSONCompact",
        });

        const statusData = JSON.parse(statusResults.text);
        const statusDistribution: Record<string, number> = {};
        let totalRuns = 0;

        statusData.data?.forEach((row: [string, number]) => {
          statusDistribution[row[0]] = row[1];
          totalRuns += row[1];
        });

        // Query 2: Top failing tasks
        const failingTasksQuery = `
          SELECT
            task_identifier,
            COUNT(*) as failure_count
          FROM trigger_dev.task_runs_v2
          WHERE
            organization_id = '${environment.organizationId}'
            AND project_id = '${environment.project.id}'
            AND environment_id = '${environment.id}'
            AND engine = 'V2'
            AND triggered_at >= '${formatClickhouseTimestamp(from)}'
            AND triggered_at < '${formatClickhouseTimestamp(to)}'
            AND status IN ('COMPLETED_WITH_ERRORS', 'CRASHED', 'TIMED_OUT')
          GROUP BY task_identifier
          ORDER BY failure_count DESC
          LIMIT 5
          SETTINGS max_execution_time = ${CLICKHOUSE_QUERY_SETTINGS.max_execution_time}
        `;

        const failingResults = await clickhouseClient.query({
          query: failingTasksQuery,
          format: "JSONCompact",
        });

        const failingData = JSON.parse(failingResults.text);
        const topFailingTasks = failingData.data?.map((row: [string, number]) => row[0]) || [];

        // Calculate error rate
        const failureCount =
          Object.entries(statusDistribution).reduce((sum, [status, count]) => {
            if (["COMPLETED_WITH_ERRORS", "CRASHED", "TIMED_OUT"].includes(status)) {
              return sum + count;
            }
            return sum;
          }, 0) || 0;

        const errorRate =
          totalRuns > 0 ? Math.round((failureCount / totalRuns) * 100) : 0;

        return {
          totalRuns,
          statusDistribution,
          topFailingTasks,
          errorRate: `${errorRate}%`,
        };
      } catch (error) {
        return {
          error: `Failed to summarize view: ${error instanceof Error ? error.message : String(error)}`,
          totalRuns: 0,
          statusDistribution: {},
          topFailingTasks: [],
          errorRate: "0%",
        };
      }
    },
  });
}
