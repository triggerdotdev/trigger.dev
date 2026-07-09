import { json } from "@remix-run/server-runtime";
import { QueryError } from "@internal/clickhouse";
import { z } from "zod";
import { createActionApiRoute, everyResource } from "~/services/routeBuilders/apiBuilder.server";
import { executeQuery, type QueryScope } from "~/services/queryService.server";
import { logger } from "~/services/logger.server";
import { rowsToCSV } from "~/utils/dataExport";
import { detectQueryTables } from "~/v3/detectQueryTables";
import { querySchemas } from "~/v3/querySchemas";

const BodySchema = z.object({
  query: z.string(),
  scope: z.enum(["organization", "project", "environment"]).default("environment"),
  period: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  format: z.enum(["json", "csv"]).default("json"),
});

const allowedQueryTables = new Set(querySchemas.map((s) => s.name));

/** Every table the query reads, for per-table JWT-scope authorization.
 * `null` means unparseable — callers deny by default. */
function detectTables(query: string): string[] | null {
  return detectQueryTables(query, allowedQueryTables);
}

const { action, loader } = createActionApiRoute(
  {
    body: BodySchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async () => 1,
    authorization: {
      action: "read",
      // A multi-table query reads from every detected table, so wrap with
      // everyResource: a JWT scoped to one table must not pass auth for a
      // query that also reads tables it isn't scoped to.
      resource: (_, __, ___, body) => {
        const tables = detectTables(body.query);
        // Unparseable query → deny. It must not fall through to the
        // permissive {type:"query",id:"all"} branch.
        if (tables === null) return { type: "query", id: "__unparseable__" };
        return tables.length > 0
          ? everyResource(tables.map((id) => ({ type: "query", id })))
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

    const { result, periodClipped: _periodClipped, maxQueryPeriod: _maxQueryPeriod } = queryResult;

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
