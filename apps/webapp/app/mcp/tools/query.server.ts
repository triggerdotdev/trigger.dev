import { QueryError } from "@internal/clickhouse";
import { logger } from "~/services/logger.server";
import { executeQuery, isQueryConcurrencyRejection } from "~/services/queryService.server";
import { env } from "~/env.server";
import { listableQuerySchemas } from "~/v3/querySchemas";
import { resolveQueryScope, type QueryScopeCeiling } from "~/v3/queryScope";
import { fenceUntrusted } from "../gate/fence.server";
import type { McpToolContext, McpToolResult } from "../gate/withMcpToolAuth.server";
import type { McpToolDefinition } from "../registry.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { formatQueryResults, formatSchemaTable } from "./format/query";
import { QueryInput, QuerySchemaInput } from "./schemas/query";
import { defineReadTool, errorResult, resolveToolEnvironment, textResult } from "./define.server";

// Same ceiling the query route applies to a delegated (non-secret-key) credential.
const MCP_QUERY_SCOPE_CEILING: QueryScopeCeiling = "environment";

export async function runScopedQuery(
  environment: AuthenticatedEnvironment,
  options: {
    query: string;
    scope: "environment" | "project" | "organization";
    period?: string | null;
    from?: string | null;
    to?: string | null;
  }
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  const resolvedScope = resolveQueryScope({
    ceiling: MCP_QUERY_SCOPE_CEILING,
    requested: options.scope,
  });
  if (!resolvedScope.ok) return { ok: false, error: resolvedScope.error };

  const queryResult = await executeQuery({
    name: "api-query",
    query: options.query,
    userAuthoredQuery: true,
    scope: resolvedScope.scope,
    organizationId: environment.organizationId,
    projectId: environment.projectId,
    environmentId: environment.id,
    period: options.period,
    from: options.from,
    to: options.to,
    history: { source: "API" },
  });

  if (!queryResult.success) {
    if (isQueryConcurrencyRejection(queryResult.error)) {
      return { ok: false, error: queryResult.error.message };
    }
    if (queryResult.error instanceof QueryError) {
      logger.warn("MCP query error", { error: queryResult.error.message });
      return { ok: false, error: queryResult.error.message };
    }
    logger.error("MCP query error", { error: queryResult.error });
    return { ok: false, error: "An unexpected error occurred while executing the query." };
  }

  return { ok: true, rows: queryResult.result.rows as Record<string, unknown>[] };
}

export function queryResultText(
  rows: Record<string, unknown>[],
  header: string[],
  source: string
): McpToolResult {
  return textResult([...header, fenceUntrusted(formatQueryResults(rows), source)].join("\n"));
}

export const subjectEnvironment = (ctx: McpToolContext) => resolveToolEnvironment(ctx);

export const queryTools: McpToolDefinition[] = [
  defineReadTool({
    name: "get_query_schema",
    title: "Get Query Schema",
    description:
      "Get the column schema for a specific TRQL table. Available tables: 'runs' (task execution data), 'metrics' (CPU, memory, custom metrics), 'llm_metrics' (LLM token usage, costs, latency). Returns columns, types, descriptions, and allowed values for the specified table.",
    shape: QuerySchemaInput.shape,
    auth: { action: "read", subject: "query" },
    run: async (input) => {
      const tables = listableQuerySchemas({
        includeQueueMetrics: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1",
      }).map(serializeTable);
      const table = tables.find((t) => t.name === input.table);

      if (!table) {
        const available = tables.map((t) => `${t.name} (${t.description ?? ""})`).join(", ");
        return errorResult(`Table "${input.table}" not found. Available tables: ${available}`);
      }

      return textResult(formatSchemaTable(table));
    },
  }),
  defineReadTool({
    name: "query",
    title: "Query",
    description:
      "Execute a TRQL query against your Trigger.dev data. TRQL is a SQL-style query language for analyzing runs, metrics, and LLM usage. Call the get_query_schema tool first to discover available tables and columns before writing a query.",
    shape: QueryInput.shape,
    auth: { action: "read", subject: "query" },
    run: async (input, ctx) => {
      const environment = await subjectEnvironment(ctx);
      if (!environment) return errorResult("Environment not found");

      const result = await runScopedQuery(environment, input);
      if (!result.ok) return errorResult(result.error);

      const rowCount = result.rows.length;
      return queryResultText(
        result.rows,
        [`## Query Results (${rowCount} row${rowCount === 1 ? "" : "s"})`, ""],
        "query"
      );
    },
  }),
];

function serializeTable(table: ReturnType<typeof listableQuerySchemas>[number]) {
  return {
    name: table.name,
    description: table.description,
    timeColumn: table.timeConstraint,
    columns: Object.values(table.columns).map((col) => ({
      name: col.name,
      type: col.type,
      description: col.description,
      example: col.example,
      allowedValues:
        col.allowedValues && col.allowedValues.length > 0
          ? col.valueMap
            ? Object.values(col.valueMap)
            : col.allowedValues
          : undefined,
      coreColumn: col.coreColumn ? true : undefined,
    })),
  };
}
