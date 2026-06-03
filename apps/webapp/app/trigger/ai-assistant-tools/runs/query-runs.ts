import { tool } from "ai";
import { queryRuns as queryRunsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext } from "../types";

export function createQueryRunsTool(ctx: ToolContext) {
  return tool({
    ...queryRunsSchema,
    execute: async (params: { question: string }) => {
      try {
        const { AIQueryService } = await import("~/v3/services/aiQueryService.server");
        const { runsSchema } = await import("~/v3/querySchemas");
        const { clickhouseClient } = await import("~/v3/clickhouse.server");
        const { prisma } = await import("~/db.server");

        // Fetch environment to validate access
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
            success: false,
            error: "Environment not found",
          };
        }

        // Create the AI query service with the schema
        const service = new AIQueryService([runsSchema]);

        // Generate a TSQL query from the natural language question
        const queryResult = await service.call(params.question);

        if (!queryResult.success) {
          return {
            success: false,
            error: queryResult.error,
          };
        }

        // Execute the query against ClickHouse, with tenant filtering
        const { Database } = await import("@internal/clickhouse");
        const db = new Database(clickhouseClient);

        // Build the final query with tenant filters applied
        const tenantFiltered = `
          SELECT *
          FROM trigger_dev.task_runs_v2
          WHERE
            organization_id = '${environment.organizationId}'
            AND project_id = '${environment.project.id}'
            AND environment_id = '${environment.id}'
            AND engine = 'V2'
            AND (${queryResult.query})
          LIMIT 100
        `;

        const results = await clickhouseClient.query({
          query: tenantFiltered,
          format: "JSONCompact",
        });

        const parsedResults = JSON.parse(results.text);

        return {
          success: true,
          query: queryResult.query,
          results: parsedResults.data || [],
          rowCount: parsedResults.rows || 0,
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to query runs: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
