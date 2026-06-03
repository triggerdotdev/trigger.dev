import { tool } from "ai";
import { correlateRunsWithDeploy as correlateRunsWithDeploySchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";
import {
  buildTimeRange,
  formatClickhouseTimestamp,
  CLICKHOUSE_QUERY_SETTINGS,
} from "./clickhouse-queries";

export function createCorrelateRunsWithDeployTool(ctx: ToolContext) {
  return tool({
    ...correlateRunsWithDeploySchema,
    execute: async (params: { taskIdentifier?: string; period?: string }) => {
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
            deploys: [],
            correlation: {},
          };
        }

        const { from, to } = buildTimeRange(params.period);

        // Query: Failure rates by deployment version
        const query = `
          SELECT
            deployment_version,
            COUNT(*) as total_runs,
            SUM(CASE WHEN status IN ('COMPLETED_WITH_ERRORS', 'CRASHED', 'TIMED_OUT') THEN 1 ELSE 0 END) as failed_runs,
            ROUND(
              SUM(CASE WHEN status IN ('COMPLETED_WITH_ERRORS', 'CRASHED', 'TIMED_OUT') THEN 1 ELSE 0 END) * 100.0 / COUNT(*),
              2
            ) as failure_rate_percent,
            MIN(triggered_at) as first_run,
            MAX(triggered_at) as last_run
          FROM trigger_dev.task_runs_v2
          WHERE
            organization_id = '${environment.organizationId}'
            AND project_id = '${environment.project.id}'
            AND environment_id = '${environment.id}'
            AND engine = 'V2'
            AND triggered_at >= '${formatClickhouseTimestamp(from)}'
            AND triggered_at < '${formatClickhouseTimestamp(to)}'
            ${params.taskIdentifier ? `AND task_identifier = '${params.taskIdentifier.replace(/'/g, "''")}'` : ""}
          GROUP BY deployment_version
          ORDER BY first_run DESC
          LIMIT 20
          SETTINGS max_execution_time = ${CLICKHOUSE_QUERY_SETTINGS.max_execution_time}
        `;

        const results = await clickhouseClient.query({
          query,
          format: "JSONCompact",
        });

        const parsed = JSON.parse(results.text);
        const deploys = parsed.data?.map((row: unknown[]) => ({
          version: row[0],
          totalRuns: row[1],
          failedRuns: row[2],
          failureRatePercent: row[3],
          firstRun: row[4],
          lastRun: row[5],
        })) || [];

        // Analyze correlation: compare failure rates between versions
        const correlation: Record<string, unknown> = {};
        if (deploys.length >= 2) {
          const current = deploys[0];
          const previous = deploys[1];

          if (current && previous) {
            const failureChange = (current.failureRatePercent as number) - (previous.failureRatePercent as number);
            correlation.currentVersion = current.version;
            correlation.previousVersion = previous.version;
            correlation.failureChangePercent = failureChange;
            correlation.isRegression = failureChange > 5; // Flag as regression if failure rate increased by >5%
            correlation.recommendation = failureChange > 5
              ? `Possible regression in version ${current.version}: failure rate increased by ${failureChange.toFixed(1)}%`
              : "No significant regression detected";
          }
        }

        return {
          deploys,
          correlation,
        };
      } catch (error) {
        return {
          error: `Failed to correlate deploys: ${error instanceof Error ? error.message : String(error)}`,
          deploys: [],
          correlation: {},
        };
      }
    },
  });
}
