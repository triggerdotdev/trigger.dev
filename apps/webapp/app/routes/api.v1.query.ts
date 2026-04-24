import { json } from "@remix-run/server-runtime";
import { QueryError } from "@internal/clickhouse";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { executeQuery, type QueryScope } from "~/services/queryService.server";
import { logger } from "~/services/logger.server";
import { rowsToCSV } from "~/utils/dataExport";
import { querySchemas } from "~/v3/querySchemas";

const BodySchema = z.object({
  query: z.string(),
  scope: z.enum(["organization", "project", "environment"]).default("environment"),
  period: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  format: z.enum(["json", "csv"]).default("json"),
});

/** Extract table names from a TRQL query for authorization */
function detectTables(query: string): string[] {
  return querySchemas
    .filter((s) => {
      const escaped = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\bFROM\\s+${escaped}\\b`, "i").test(query);
    })
    .map((s) => s.name);
}

const { action, loader } = createActionApiRoute(
  {
    body: BodySchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1,
    authorization: {
      action: "read",
      resource: (_, __, ___, body) => {
        const tables = detectTables(body.query);
        return tables.length > 0
          ? tables.map((id) => ({ type: "query", id }))
          : { type: "query", id: "all" };
      },
    },
  },
  async ({ body, authentication }) => {
    const { query, scope, period, from, to, format } = body;
    const env = authentication.environment;

    const queryResult = await executeQuery({
      name: "api-query",
      query,
      scope: scope as QueryScope,
      organizationId: env.organization.id,
      projectId: env.project.id,
      environmentId: env.id,
      period,
      from,
      to,
      history: {
        source: "API",
      },
    });

    if (!queryResult.success) {
      // QueryError surfaces customer SQL problems (invalid syntax,
      // unsupported construct). Returned to the caller as 400; system
      // handles it gracefully, no alert needed.
      if (queryResult.error instanceof QueryError) {
        logger.warn("Query API error", {
          error: queryResult.error.message,
          query,
        });
        return json({ error: queryResult.error.message }, { status: 400 });
      }

      logger.error("Query API error", {
        error: queryResult.error,
        query,
      });

      return json(
        { error: "An unexpected error occurred while executing the query." },
        { status: 500 }
      );
    }

    const { result, periodClipped, maxQueryPeriod } = queryResult;

    if (format === "csv") {
      const csv = rowsToCSV(result.rows, result.columns);

      return json({
        format: "csv",
        results: csv,
      });
    }

    return json({
      format: "json",
      results: result.rows,
    });
  }
);

export { action, loader };
