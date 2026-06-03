import { tool } from "ai";
import { findSimilarErrors as findSimilarErrorsSchema } from "~/lib/ai-assistant/tool-schemas";
import type { ToolContext, ErrorGroupSummary } from "../types";

export function createFindSimilarErrorsTool(ctx: ToolContext) {
  return tool({
    ...findSimilarErrorsSchema,
    execute: async (params: { errorMessage: string; limit?: number }) => {
      try {
        const { clickhouseClient } = await import("~/v3/clickhouse.server");
        const { prisma } = await import("~/db.server");

        // Get the environment
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
            errors: [],
            error: "Environment not found",
          };
        }

        // Search for similar error messages using LIKE
        const limit = params.limit || 10;
        const searchTerm = params.errorMessage.substring(0, 100); // Use first 100 chars to avoid extremely long searches

        const query = `
          SELECT
            error_fingerprint,
            error_message,
            task_identifier,
            COUNT(*) as occurrence_count,
            MIN(triggered_at) as first_seen,
            MAX(triggered_at) as last_seen
          FROM trigger_dev.task_runs_v2
          WHERE
            organization_id = '${environment.organizationId}'
            AND project_id = '${environment.project.id}'
            AND environment_id = '${environment.id}'
            AND engine = 'V2'
            AND error_message ILIKE '%${searchTerm.replace(/'/g, "''")}%'
          GROUP BY error_fingerprint, error_message, task_identifier
          ORDER BY occurrence_count DESC
          LIMIT ${limit}
        `;

        const results = await clickhouseClient.query({
          query,
          format: "JSONCompact",
        });

        const parsed = JSON.parse(results.text);
        const errors: ErrorGroupSummary[] = parsed.data?.map((row: any) => ({
          fingerprint: row[0],
          message: row[1],
          taskIdentifier: row[2],
          count: row[3],
          firstSeen: new Date(row[4]).toISOString(),
          lastSeen: new Date(row[5]).toISOString(),
          status: "UNRESOLVED",
        })) || [];

        return {
          errors,
          total: errors.length,
        };
      } catch (error) {
        return {
          errors: [],
          error: `Failed to find similar errors: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },
  });
}
