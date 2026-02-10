import { json } from "@remix-run/server-runtime";
import { QueryError } from "@internal/clickhouse";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { executeQuery, type QueryScope } from "~/services/queryService.server";
import { logger } from "~/services/logger.server";
import { rowsToCSV } from "~/utils/dataExport";

const BodySchema = z.object({
  query: z.string(),
  scope: z.enum(["organization", "project", "environment"]).default("environment"),
  period: z.string().nullish(),
  from: z.string().nullish(),
  to: z.string().nullish(),
  format: z.enum(["json", "csv"]).default("json"),
});

const { action, loader } = createActionApiRoute(
  {
    body: BodySchema,
    corsStrategy: "all",
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
      const message =
        queryResult.error instanceof QueryError
          ? queryResult.error.message
          : "An unexpected error occurred while executing the query.";

      logger.error("Query API error", {
        error: queryResult.error,
        query,
      });

      return json({ error: message }, { status: 400 });
    }

    const { result, periodClipped, maxQueryPeriod } = queryResult;

    if (format === "csv") {
      const csv = rowsToCSV(result.rows, result.columns);

      return new Response(csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": "attachment; filename=query-results.csv",
        },
      });
    }

    return json({
      rows: result.rows,
    });
  }
);

export { action, loader };
