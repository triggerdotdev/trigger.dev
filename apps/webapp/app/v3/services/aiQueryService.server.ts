import { openai } from "@ai-sdk/openai";
import {
  parseTSQLSelect,
  validateQuery,
  type TableSchema,
  type ValidationIssue,
} from "@internal/tsql";
import { streamText, type LanguageModelV1, tool } from "ai";
import { z } from "zod";
import type { AITimeFilter } from "~/routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.query/types";

// Re-export for backwards compatibility
export type { AITimeFilter };

/**
 * Stream event types for AI query generation
 */
export type AIQueryStreamEvent =
  | { type: "thinking"; content: string }
  | { type: "tool_call"; tool: string; args: unknown }
  | { type: "tool_result"; tool: string; result: unknown }
  | { type: "time_filter"; filter: AITimeFilter }
  | { type: "result"; success: true; query: string; timeFilter?: AITimeFilter }
  | { type: "result"; success: false; error: string };

/**
 * Result type for non-streaming call
 */
export type AIQueryResult =
  | { success: true; query: string; timeFilter?: AITimeFilter }
  | { success: false; error: string };

/**
 * Options for query generation
 */
export interface AIQueryOptions {
  mode?: "new" | "edit";
  currentQuery?: string;
}

/**
 * Validation result from the validateTSQLQuery tool
 */
interface QueryValidationResult {
  valid: boolean;
  syntaxError?: string;
  issues: ValidationIssue[];
}

/**
 * Service for generating TSQL queries from natural language using AI
 */
export class AIQueryService {
  private pendingTimeFilter: AITimeFilter | undefined;

  constructor(
    private readonly tableSchema: TableSchema[],
    private readonly model: LanguageModelV1 = openai("gpt-4o-mini")
  ) {}

  /**
   * Build the setTimeFilter tool definition
   * Used by both streamQuery() and call() to keep behavior consistent
   */
  private buildSetTimeFilterTool() {
    return tool({
      description:
        "Set the time filter for the query page UI instead of adding triggered_at conditions to the query. ALWAYS use this tool when the user wants to filter by time (e.g., 'last 7 days', 'past hour', 'yesterday'). The UI will apply this filter automatically. Do NOT add triggered_at to the WHERE clause - use this tool instead.",
      parameters: z.object({
        period: z
          .string()
          .optional()
          .describe(
            "Relative time period like '1m', '5m', '30m', '1h', '6h', '12h', '1d', '3d', '7d', '14d', '30d', '90d'. Use this for 'last X days/hours/minutes' requests."
          ),
        from: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp for the start of an absolute date range. Use with 'to' for specific date ranges."
          ),
        to: z
          .string()
          .optional()
          .describe(
            "ISO 8601 timestamp for the end of an absolute date range. Use with 'from' for specific date ranges."
          ),
      }),
      execute: async ({ period, from, to }) => {
        // Store the time filter so we can include it in the result
        this.pendingTimeFilter = { period, from, to };
        return {
          success: true,
          message: period
            ? `Time filter set to: last ${period}`
            : `Time filter set to: ${from ?? "start"} - ${to ?? "now"}`,
        };
      },
    });
  }

  /**
   * Generate a TSQL query from natural language, streaming the result
   */
  streamQuery(prompt: string, options: AIQueryOptions = {}) {
    const { mode = "new", currentQuery } = options;
    // Reset pending time filter for new request
    this.pendingTimeFilter = undefined;

    const schemaDescription = this.buildSchemaDescription();
    const systemPrompt =
      mode === "edit" && currentQuery
        ? this.buildEditSystemPrompt(schemaDescription)
        : this.buildSystemPrompt(schemaDescription);

    // Build the user prompt based on mode
    const userPrompt =
      mode === "edit" && currentQuery ? this.buildEditUserPrompt(prompt, currentQuery) : prompt;

    return streamText({
      model: this.model,
      system: systemPrompt,
      prompt: userPrompt,
      tools: {
        validateTSQLQuery: tool({
          description:
            "Validate a TSQL query for syntax errors and schema compliance. Always use this tool to verify your query before returning it to the user.",
          parameters: z.object({
            query: z.string().describe("The TSQL query to validate"),
          }),
          execute: async ({ query }) => {
            return this.validateQuery(query);
          },
        }),
        getTableSchema: tool({
          description:
            "Get detailed schema information about available tables and columns. Use this to understand what data is available and how to query it.",
          parameters: z.object({
            tableName: z
              .string()
              .optional()
              .describe("Optional: specific table name to get details for"),
          }),
          execute: async ({ tableName }) => {
            return this.getSchemaInfo(tableName);
          },
        }),
        setTimeFilter: this.buildSetTimeFilterTool(),
      },
      maxSteps: 5,
      experimental_telemetry: {
        isEnabled: true,
        metadata: {
          feature: "ai-query-generator",
          mode,
        },
      },
    });
  }

  /**
   * Get the pending time filter (set by the AI during query generation)
   */
  getPendingTimeFilter(): AITimeFilter | undefined {
    return this.pendingTimeFilter;
  }

  /**
   * Generate a TSQL query from natural language (non-streaming)
   */
  async call(prompt: string, options: AIQueryOptions = {}): Promise<AIQueryResult> {
    const { mode = "new", currentQuery } = options;
    // Reset pending time filter for new request
    this.pendingTimeFilter = undefined;

    const schemaDescription = this.buildSchemaDescription();
    const systemPrompt =
      mode === "edit" && currentQuery
        ? this.buildEditSystemPrompt(schemaDescription)
        : this.buildSystemPrompt(schemaDescription);

    // Build the user prompt based on mode
    const userPrompt =
      mode === "edit" && currentQuery ? this.buildEditUserPrompt(prompt, currentQuery) : prompt;

    const result = await streamText({
      model: this.model,
      system: systemPrompt,
      prompt: userPrompt,
      tools: {
        validateTSQLQuery: tool({
          description:
            "Validate a TSQL query for syntax errors and schema compliance. Always use this tool to verify your query before returning it to the user.",
          parameters: z.object({
            query: z.string().describe("The TSQL query to validate"),
          }),
          execute: async ({ query }) => {
            return this.validateQuery(query);
          },
        }),
        getTableSchema: tool({
          description:
            "Get detailed schema information about available tables and columns. Use this to understand what data is available and how to query it.",
          parameters: z.object({
            tableName: z
              .string()
              .optional()
              .describe("Optional: specific table name to get details for"),
          }),
          execute: async ({ tableName }) => {
            return this.getSchemaInfo(tableName);
          },
        }),
        setTimeFilter: this.buildSetTimeFilterTool(),
      },
      maxSteps: 5,
      experimental_telemetry: {
        isEnabled: true,
        metadata: {
          feature: "ai-query-generator",
          mode,
        },
      },
    });

    // Wait for the full response
    const text = await result.text;

    // Try to extract a valid query from the response
    const query = this.extractQueryFromResponse(text);

    if (query) {
      // Validate the extracted query one more time
      const validation = this.validateQuery(query);
      if (validation.valid) {
        return { success: true, query, timeFilter: this.pendingTimeFilter };
      } else {
        const errorMessages = validation.issues.map((i) => i.message).join("; ");
        return {
          success: false,
          error: validation.syntaxError || errorMessages || "Query validation failed",
        };
      }
    }

    // If no query was found, check if there's an error message
    if (text.toLowerCase().includes("cannot") || text.toLowerCase().includes("unable")) {
      return { success: false, error: text.slice(0, 200) };
    }

    return { success: false, error: "Could not generate a valid query" };
  }

  /**
   * Validate a TSQL query using the parser and validator
   */
  private validateQuery(query: string): QueryValidationResult {
    try {
      // First, try to parse the query
      const ast = parseTSQLSelect(query);

      // Then validate against the schema
      const validationResult = validateQuery(ast, this.tableSchema);

      return {
        valid: validationResult.valid,
        issues: validationResult.issues,
      };
    } catch (error) {
      // Syntax error during parsing
      return {
        valid: false,
        syntaxError: error instanceof Error ? error.message : String(error),
        issues: [],
      };
    }
  }

  /**
   * Get schema information for the AI
   */
  private getSchemaInfo(tableName?: string): {
    tables: Array<{
      name: string;
      description?: string;
      columns: Array<{
        name: string;
        type: string;
        description?: string;
        allowedValues?: string[];
        example?: string;
      }>;
    }>;
  } {
    const tables = tableName
      ? this.tableSchema.filter((t) => t.name.toLowerCase() === tableName?.toLowerCase())
      : this.tableSchema;

    return {
      tables: tables.map((table) => ({
        name: table.name,
        description: table.description,
        columns: Object.values(table.columns).map((col) => ({
          name: col.name,
          type: col.type,
          description: col.description,
          allowedValues: col.valueMap ? Object.values(col.valueMap) : col.allowedValues,
          example: col.example,
        })),
      })),
    };
  }

  /**
   * Build a description of the schema for the system prompt
   */
  private buildSchemaDescription(): string {
    const parts: string[] = [];

    for (const table of this.tableSchema) {
      parts.push(`## Table: ${table.name}`);
      if (table.description) {
        parts.push(table.description);
      }
      parts.push("");

      // Identify core columns
      const coreColumns = Object.values(table.columns)
        .filter((col) => col.coreColumn === true)
        .map((col) => col.name);
      if (coreColumns.length > 0) {
        parts.push(`Core columns (use these as defaults): ${coreColumns.join(", ")}`);
        parts.push("");
      }

      parts.push("Columns:");

      for (const col of Object.values(table.columns)) {
        let colDesc = `- ${col.name} (${col.type})`;
        if (col.coreColumn) {
          colDesc += " [CORE]";
        }
        if (col.description) {
          colDesc += `: ${col.description}`;
        }
        parts.push(colDesc);

        // Add allowed values for enum-like columns
        const allowedValues = col.valueMap ? Object.values(col.valueMap) : col.allowedValues;
        if (allowedValues && allowedValues.length > 0 && allowedValues.length <= 20) {
          parts.push(`  Allowed values: ${allowedValues.join(", ")}`);
        }

        // Add example if available
        if (col.example) {
          parts.push(`  Example: ${col.example}`);
        }
      }
      parts.push("");
    }

    return parts.join("\n");
  }

  /**
   * Build the system prompt for the AI
   */
  private buildSystemPrompt(schemaDescription: string): string {
    return `You are an expert SQL assistant that generates TSQL queries for a task run analytics system. TSQL is a SQL dialect similar to ClickHouse SQL.

## Your Task
Convert natural language requests into valid TSQL SELECT queries. Always validate your queries using the validateTSQLQuery tool before returning them.

## Available Schema
${schemaDescription}

## TSQL Syntax Guide

TSQL supports standard SQL syntax with some ClickHouse-specific features:

### Basic SELECT
\`\`\`sql
SELECT column1, column2, ...
FROM table_name
WHERE conditions
ORDER BY column [ASC|DESC]
LIMIT n
\`\`\`

### Filtering (WHERE clause)
- Comparison: =, !=, <, >, <=, >=
- Logical: AND, OR, NOT
- Pattern matching: LIKE, ILIKE (case-insensitive), NOT LIKE
- Range: BETWEEN value1 AND value2
- Set membership: IN ('value1', 'value2'), NOT IN (...)
- Null checks: IS NULL, IS NOT NULL
- Array contains: has(array_column, 'value')

### Aggregations
- count() - count rows
- countIf(condition) - count rows matching condition
- sum(column), sumIf(column, condition)
- avg(column), min(column), max(column)
- uniq(column) - approximate unique count
- quantile(p)(column) - percentile (p between 0 and 1)
- groupArray(column) - collect values into array

### Grouping
\`\`\`sql
SELECT column, count() as cnt
FROM table
GROUP BY column
HAVING cnt > 10
\`\`\`

### Date/Time Functions
- now() - current timestamp
- today() - current date
- toDate(datetime) - extract date
- toStartOfDay/Hour/Minute(datetime)
- dateDiff('unit', start, end) - difference in units (second, minute, hour, day, week, month, year)
- INTERVAL n unit - time interval (e.g., INTERVAL 7 DAY)

### Common Patterns
- Status filter: WHERE status = 'Failed' or WHERE status IN ('Failed', 'Crashed')
- Time filtering: Use the \`setTimeFilter\` tool (NOT triggered_at in WHERE clause)

## Important Rules

1. NEVER use SELECT * - ClickHouse is a columnar database where SELECT * has very poor performance
2. Always select only the specific columns needed for the request
3. When column selection is ambiguous, use the core columns marked [CORE] in the schema
4. **TIME FILTERING**: When the user wants to filter by time (e.g., "last 7 days", "past hour", "yesterday"), ALWAYS use the \`setTimeFilter\` tool instead of adding \`triggered_at\` conditions to the query. The UI has a time filter that will apply this automatically.
5. Do NOT add \`triggered_at\` to WHERE clauses - use \`setTimeFilter\` tool instead. If the user doesn't specify a time period, do NOT add any time filter (the UI defaults to 7 days).
6. ALWAYS use the validateTSQLQuery tool to check your query before returning it
7. If validation fails, fix the issues and try again (up to 3 attempts)
8. Use column names exactly as defined in the schema (case-sensitive)
9. For enum columns like status, use the allowed values shown in the schema
10. Always include a LIMIT clause (default to 100 if not specified)
11. Use meaningful column aliases with AS for aggregations
12. Format queries with proper indentation for readability

## Response Format

After validating successfully, return ONLY the SQL query wrapped in a code block:

\`\`\`sql
SELECT ...
FROM ...
\`\`\`

If you cannot generate a valid query, explain why briefly.`;
  }

  /**
   * Build the system prompt for edit mode
   */
  private buildEditSystemPrompt(schemaDescription: string): string {
    return `You are an expert SQL assistant that modifies existing TSQL queries for a task run analytics system. TSQL is a SQL dialect similar to ClickHouse SQL.

## Your Task
Modify the provided TSQL query according to the user's instructions. Make only the changes requested - preserve the existing query structure where possible.

## Available Schema
${schemaDescription}

## TSQL Syntax Guide

TSQL supports standard SQL syntax with some ClickHouse-specific features:

### Basic SELECT
\`\`\`sql
SELECT column1, column2, ...
FROM table_name
WHERE conditions
ORDER BY column [ASC|DESC]
LIMIT n
\`\`\`

### Filtering (WHERE clause)
- Comparison: =, !=, <, >, <=, >=
- Logical: AND, OR, NOT
- Pattern matching: LIKE, ILIKE (case-insensitive), NOT LIKE
- Range: BETWEEN value1 AND value2
- Set membership: IN ('value1', 'value2'), NOT IN (...)
- Null checks: IS NULL, IS NOT NULL
- Array contains: has(array_column, 'value')

### Aggregations
- count() - count rows
- countIf(condition) - count rows matching condition
- sum(column), sumIf(column, condition)
- avg(column), min(column), max(column)
- uniq(column) - approximate unique count
- quantile(p)(column) - percentile (p between 0 and 1)
- groupArray(column) - collect values into array

### Grouping
\`\`\`sql
SELECT column, count() as cnt
FROM table
GROUP BY column
HAVING cnt > 10
\`\`\`

### Date/Time Functions
- now() - current timestamp
- today() - current date
- toDate(datetime) - extract date
- toStartOfDay/Hour/Minute(datetime)
- dateDiff('unit', start, end) - difference in units (second, minute, hour, day, week, month, year)
- INTERVAL n unit - time interval (e.g., INTERVAL 7 DAY)

## Important Rules

1. NEVER use SELECT * - ClickHouse is a columnar database where SELECT * has very poor performance
2. If the existing query uses SELECT *, replace it with specific columns (use core columns marked [CORE] as defaults)
3. **TIME FILTERING**: When the user wants to change time filtering (e.g., "change to last 30 days"), use the \`setTimeFilter\` tool instead of modifying \`triggered_at\` conditions. If the existing query has \`triggered_at\` in WHERE, consider removing it and using \`setTimeFilter\` instead.
4. ALWAYS use the validateTSQLQuery tool to check your modified query before returning it
5. If validation fails, fix the issues and try again (up to 3 attempts)
6. Use column names exactly as defined in the schema (case-sensitive)
7. For enum columns like status, use the allowed values shown in the schema
8. Always include a LIMIT clause (default to 100 if not specified)
9. Preserve the user's existing query structure and style where possible
10. Only make the changes specifically requested by the user

## Response Format

After validating successfully, return ONLY the modified SQL query wrapped in a code block:

\`\`\`sql
SELECT ...
FROM ...
\`\`\`

If you cannot make the requested modification, explain why briefly.`;
  }

  /**
   * Build the user prompt for edit mode
   */
  private buildEditUserPrompt(userRequest: string, currentQuery: string): string {
    return `Here is the current TSQL query:

\`\`\`sql
${currentQuery}
\`\`\`

Please modify this query according to the following instructions:

${userRequest}`;
  }

  /**
   * Extract a SQL query from the AI response text
   */
  private extractQueryFromResponse(text: string): string | null {
    // Try to extract from code block first
    const codeBlockMatch = text.match(/```(?:sql)?\s*([\s\S]*?)```/i);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    // Try to find a SELECT statement
    const selectMatch = text.match(/SELECT[\s\S]+?(?:LIMIT\s+\d+|;|$)/i);
    if (selectMatch) {
      return selectMatch[0].trim().replace(/;$/, "");
    }

    return null;
  }
}
