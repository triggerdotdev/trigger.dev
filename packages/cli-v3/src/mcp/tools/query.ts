import type { QuerySchemaResponseBody, QuerySchemaTable } from "@trigger.dev/core/v3/schemas";
import { toolsMetadata } from "../config.js";
import { formatQueryResults } from "../formatters.js";
import { QueryInput, QuerySchemaInput } from "../schemas.js";
import { respondWithError, toolHandler } from "../utils.js";

// Cache query schema (rarely changes)
let schemaCache: { data: QuerySchemaResponseBody; expiresAt: number } | null = null;
const SCHEMA_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export const queryTool = {
  name: toolsMetadata.query.name,
  title: toolsMetadata.query.title,
  description: toolsMetadata.query.description,
  inputSchema: QueryInput.shape,
  handler: toolHandler(QueryInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling query", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:query"],
      branch: input.branch,
    });

    const result = await apiClient.executeQuery(input.query, {
      scope: input.scope,
      period: input.period,
      from: input.from,
      to: input.to,
      format: "json",
    });

    if (result.format === "json") {
      const rowCount = result.results.length;
      const formatted = formatQueryResults(result.results as Record<string, unknown>[]);

      const content = [
        `## Query Results (${rowCount} row${rowCount === 1 ? "" : "s"})`,
        "",
        formatted,
      ];

      return {
        content: [{ type: "text" as const, text: content.join("\n") }],
      };
    }

    return {
      content: [{ type: "text" as const, text: result.results }],
    };
  }),
};

function formatSchemaTable(table: QuerySchemaTable): string {
  const lines: string[] = [];

  lines.push(`### ${table.name}`);
  if (table.description) {
    lines.push(table.description);
  }
  if (table.timeColumn) {
    lines.push(`**Time column:** \`${table.timeColumn}\``);
  }
  lines.push("");

  // Format columns as a table
  lines.push("| Column | Type | Description |");
  lines.push("|--------|------|-------------|");

  for (const col of table.columns) {
    const parts: string[] = [];

    if (col.description) {
      parts.push(col.description);
    }
    if (col.allowedValues && col.allowedValues.length > 0) {
      parts.push(`Values: ${col.allowedValues.join(", ")}`);
    }
    if (col.example) {
      parts.push(`e.g. \`${col.example}\``);
    }

    const core = col.coreColumn ? " *" : "";
    const desc = parts.join(". ").replace(/\|/g, "\\|");

    lines.push(`| \`${col.name}\`${core} | ${col.type} | ${desc} |`);
  }

  lines.push("");
  lines.push("\\* = core column (included in default queries)");

  return lines.join("\n");
}

export const getQuerySchemaTool = {
  name: toolsMetadata.get_query_schema.name,
  title: toolsMetadata.get_query_schema.title,
  description: toolsMetadata.get_query_schema.description,
  inputSchema: QuerySchemaInput.shape,
  handler: toolHandler(QuerySchemaInput.shape, async (input, { ctx }) => {
    ctx.logger?.log("calling get_query_schema", { input });

    if (ctx.options.devOnly && input.environment !== "dev") {
      return respondWithError(
        `This MCP server is only available for the dev environment. You tried to access the ${input.environment} environment. Remove the --dev-only flag to access other environments.`
      );
    }

    const projectRef = await ctx.getProjectRef({
      projectRef: input.projectRef,
      cwd: input.configPath,
    });

    const apiClient = await ctx.getApiClient({
      projectRef,
      environment: input.environment,
      scopes: ["read:query"],
      branch: input.branch,
    });

    let schema: QuerySchemaResponseBody;
    if (schemaCache && Date.now() < schemaCache.expiresAt) {
      schema = schemaCache.data;
    } else {
      schema = await apiClient.getQuerySchema();
      schemaCache = { data: schema, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS };
    }

    const table = schema.tables.find((t) => t.name === input.table);

    if (!table) {
      const available = schema.tables.map((t) => `${t.name} (${t.description ?? ""})`).join(", ");
      return respondWithError(
        `Table "${input.table}" not found. Available tables: ${available}`
      );
    }

    const content = [formatSchemaTable(table)];

    return {
      content: [{ type: "text" as const, text: content.join("\n") }],
    };
  }),
};
