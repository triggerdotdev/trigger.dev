import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import type { TableSchema, ColumnSchema } from "@internal/tsql";
import {
  TSQL_CLICKHOUSE_FUNCTIONS,
  TSQL_AGGREGATIONS,
} from "@internal/tsql";

/**
 * SQL keywords for autocomplete
 */
const SQL_KEYWORDS = [
  "SELECT",
  "FROM",
  "WHERE",
  "AND",
  "OR",
  "NOT",
  "IN",
  "LIKE",
  "ILIKE",
  "BETWEEN",
  "IS",
  "NULL",
  "TRUE",
  "FALSE",
  "AS",
  "ORDER",
  "BY",
  "ASC",
  "DESC",
  "LIMIT",
  "OFFSET",
  "GROUP",
  "HAVING",
  "DISTINCT",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "FULL",
  "CROSS",
  "ON",
  "UNION",
  "INTERSECT",
  "EXCEPT",
  "ALL",
  "WITH",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "OVER",
  "PARTITION",
  "ROWS",
  "RANGE",
  "UNBOUNDED",
  "PRECEDING",
  "FOLLOWING",
  "CURRENT",
  "ROW",
  "NULLS",
  "FIRST",
  "LAST",
];

/**
 * Create keyword completions from the SQL keywords list
 */
function createKeywordCompletions(): Completion[] {
  return SQL_KEYWORDS.map((keyword) => ({
    label: keyword,
    type: "keyword",
    boost: -1, // Keywords should have lower priority than schema items
  }));
}

/**
 * Create function completions from TSQL function definitions
 */
function createFunctionCompletions(): Completion[] {
  const functions: Completion[] = [];

  // Add regular functions
  for (const [name, meta] of Object.entries(TSQL_CLICKHOUSE_FUNCTIONS)) {
    // Skip internal functions starting with _
    if (name.startsWith("_")) continue;

    const argsHint =
      meta.maxArgs === 0 ? "()" : meta.minArgs === meta.maxArgs ? `(${meta.minArgs} args)` : `(${meta.minArgs}${meta.maxArgs ? `-${meta.maxArgs}` : "+"} args)`;

    functions.push({
      label: name,
      type: "function",
      detail: argsHint,
      apply: `${name}()`,
    });
  }

  // Add aggregate functions with slightly higher boost
  for (const [name, meta] of Object.entries(TSQL_AGGREGATIONS)) {
    if (name.startsWith("_")) continue;

    const argsHint =
      meta.maxArgs === 0 ? "()" : meta.minArgs === meta.maxArgs ? `(${meta.minArgs} args)` : `(${meta.minArgs}${meta.maxArgs ? `-${meta.maxArgs}` : "+"} args)`;

    functions.push({
      label: name,
      type: "function",
      detail: `aggregate ${argsHint}`,
      apply: `${name}()`,
      boost: 0.5,
    });
  }

  return functions;
}

/**
 * Create table completions from schema
 */
function createTableCompletions(schema: TableSchema[]): Completion[] {
  return schema.map((table) => ({
    label: table.name,
    type: "class", // Using "class" type for tables gives them a nice icon
    detail: table.description || "table",
    boost: 1, // Tables should have higher priority
  }));
}

/**
 * Create column completions for a specific table
 */
function createColumnCompletions(table: TableSchema, prefix?: string): Completion[] {
  const columns: Completion[] = [];

  for (const [name, column] of Object.entries(table.columns)) {
    columns.push({
      label: prefix ? `${prefix}.${name}` : name,
      type: "property", // Using "property" type for columns
      detail: `${column.type}${column.description ? ` - ${column.description}` : ""}`,
      boost: 2, // Columns should have highest priority
    });
  }

  return columns;
}

/**
 * Extract table names/aliases from the current query context
 * This is a simplified parser that looks for FROM and JOIN clauses
 */
function extractTablesFromQuery(doc: string, schema: TableSchema[]): Map<string, TableSchema> {
  const tableMap = new Map<string, TableSchema>();
  const tableNames = schema.map((t) => t.name);

  // Simple regex to find table references in FROM and JOIN clauses
  // Handles: FROM table_name, FROM table_name AS alias, FROM table_name alias
  const tablePattern =
    /(?:FROM|JOIN)\s+(\w+)(?:\s+(?:AS\s+)?(\w+))?/gi;

  let match;
  while ((match = tablePattern.exec(doc)) !== null) {
    const tableName = match[1];
    const alias = match[2] || tableName;

    // Find the table schema if it exists
    const tableSchema = schema.find(
      (t) => t.name.toLowerCase() === tableName.toLowerCase()
    );

    if (tableSchema) {
      tableMap.set(alias.toLowerCase(), tableSchema);
    }
  }

  return tableMap;
}

/**
 * Determine what context we're in based on cursor position
 */
type CompletionContextType =
  | "table" // After FROM or JOIN
  | "column" // After SELECT, WHERE, ORDER BY, GROUP BY, etc.
  | "alias" // After table_name.
  | "value" // After comparison operator (=, !=, IN, etc.)
  | "general"; // Anywhere else

/**
 * Result of context detection
 */
interface ContextResult {
  type: CompletionContextType;
  tablePrefix?: string;
  /** Column being compared (for value context) */
  columnName?: string;
  /** Table alias for the column (for value context) */
  columnTableAlias?: string;
}

/**
 * Extract column name from text before a comparison operator
 * Handles: "column =", "table.column =", "column IN", etc.
 */
function extractColumnBeforeOperator(textBefore: string): { columnName: string; tableAlias?: string } | null {
  // Match patterns like: column =, column !=, column IN, table.column =, etc.
  // We need to capture the column (and optional table prefix) before the operator
  const patterns = [
    // column = or column != or column <> (with optional whitespace)
    /(\w+)\.(\w+)\s*(?:=|!=|<>)\s*$/i,
    /(\w+)\s*(?:=|!=|<>)\s*$/i,
    // column IN ( or column NOT IN (
    /(\w+)\.(\w+)\s+(?:NOT\s+)?IN\s*\(\s*$/i,
    /(\w+)\s+(?:NOT\s+)?IN\s*\(\s*$/i,
    // After a comma in IN clause - need to find the column before IN
    /(\w+)\.(\w+)\s+(?:NOT\s+)?IN\s*\([^)]*,\s*$/i,
    /(\w+)\s+(?:NOT\s+)?IN\s*\([^)]*,\s*$/i,
  ];

  for (const pattern of patterns) {
    const match = textBefore.match(pattern);
    if (match) {
      if (match.length === 3) {
        // table.column pattern
        return { tableAlias: match[1], columnName: match[2] };
      } else {
        // just column pattern
        return { columnName: match[1] };
      }
    }
  }

  return null;
}

function determineContext(
  doc: string,
  pos: number
): ContextResult {
  // Get text before cursor
  const textBefore = doc.slice(0, pos);

  // Check if we're in a value context (after comparison operator)
  // This should be checked before other contexts
  const columnInfo = extractColumnBeforeOperator(textBefore);
  if (columnInfo) {
    return {
      type: "value",
      columnName: columnInfo.columnName,
      columnTableAlias: columnInfo.tableAlias,
    };
  }

  // Check if we're completing after a dot (table.column)
  const dotMatch = textBefore.match(/(\w+)\.\s*$/);
  if (dotMatch) {
    return { type: "alias", tablePrefix: dotMatch[1] };
  }

  // Find the LAST significant keyword before cursor
  // We match all keywords and take the last one
  const keywordPattern = /\b(SELECT|FROM|JOIN|WHERE|AND|OR|ORDER\s+BY|GROUP\s+BY|HAVING|ON)\b/gi;
  let lastMatch: RegExpExecArray | null = null;
  let match: RegExpExecArray | null;

  while ((match = keywordPattern.exec(textBefore)) !== null) {
    lastMatch = match;
  }

  if (lastMatch) {
    const keyword = lastMatch[1].toUpperCase().replace(/\s+/g, " ");

    if (keyword === "FROM" || keyword === "JOIN") {
      return { type: "table" };
    }

    if (
      keyword === "SELECT" ||
      keyword === "WHERE" ||
      keyword === "AND" ||
      keyword === "OR" ||
      keyword === "ORDER BY" ||
      keyword === "GROUP BY" ||
      keyword === "HAVING" ||
      keyword === "ON"
    ) {
      return { type: "column" };
    }
  }

  return { type: "general" };
}

/**
 * Find a column schema by name in the tables map
 */
function findColumnSchema(
  columnName: string,
  tableAlias: string | undefined,
  tables: Map<string, TableSchema>
): ColumnSchema | null {
  if (tableAlias) {
    // Look in specific table
    const tableSchema = tables.get(tableAlias.toLowerCase());
    if (tableSchema) {
      return tableSchema.columns[columnName] || null;
    }
  } else {
    // Look in all tables
    for (const tableSchema of tables.values()) {
      const col = tableSchema.columns[columnName];
      if (col) {
        return col;
      }
    }
  }
  return null;
}

/**
 * Create completions for enum values
 */
function createEnumValueCompletions(columnSchema: ColumnSchema): Completion[] {
  if (!columnSchema.allowedValues || columnSchema.allowedValues.length === 0) {
    return [];
  }

  return columnSchema.allowedValues.map((value) => ({
    label: `'${value}'`,
    type: "enum",
    detail: columnSchema.description || "allowed value",
    boost: 3, // Highest priority for enum values in value context
  }));
}

/**
 * Create a TSQL-aware autocompletion source
 *
 * @param schema - Array of table schemas to use for completions
 * @returns A CodeMirror completion source function
 */
export function createTSQLCompletion(
  schema: TableSchema[]
): (context: CompletionContext) => CompletionResult | null {
  // Pre-compute static completions
  const keywordCompletions = createKeywordCompletions();
  const functionCompletions = createFunctionCompletions();
  const tableCompletions = createTableCompletions(schema);

  return (context: CompletionContext): CompletionResult | null => {
    // Get the word being typed - include single quotes for value completion
    const word = context.matchBefore(/[\w.']+/);

    // Don't show completions if no word is being typed and not explicitly triggered
    if (!word && !context.explicit) {
      return null;
    }

    const from = word ? word.from : context.pos;
    const doc = context.state.doc.toString();
    const queryContext = determineContext(doc, context.pos);

    let options: Completion[] = [];

    switch (queryContext.type) {
      case "table":
        // After FROM or JOIN, show only tables
        options = tableCompletions;
        break;

      case "alias":
        // After table., show columns for that table
        if (queryContext.tablePrefix) {
          const tables = extractTablesFromQuery(doc, schema);
          const tableSchema = tables.get(queryContext.tablePrefix.toLowerCase());

          if (tableSchema) {
            options = createColumnCompletions(tableSchema);
          }
        }
        break;

      case "value":
        // After comparison operator, show enum values if available
        if (queryContext.columnName) {
          const tables = extractTablesFromQuery(doc, schema);
          const columnSchema = findColumnSchema(
            queryContext.columnName,
            queryContext.columnTableAlias,
            tables
          );

          if (columnSchema) {
            options = createEnumValueCompletions(columnSchema);
          }
        }
        break;

      case "column":
        // After SELECT, WHERE, etc., show columns, functions, and some keywords
        {
          const tables = extractTablesFromQuery(doc, schema);

          // Add columns from all tables in the query
          tables.forEach((tableSchema, alias) => {
            // If multiple tables, prefix with alias
            const prefix = tables.size > 1 ? alias : undefined;
            options.push(...createColumnCompletions(tableSchema, prefix));
          });

          // Also add functions and relevant keywords
          options.push(...functionCompletions);
          options.push(
            ...keywordCompletions.filter((k) =>
              ["AND", "OR", "NOT", "IN", "LIKE", "ILIKE", "BETWEEN", "IS", "NULL", "AS", "CASE", "WHEN", "THEN", "ELSE", "END"].includes(
                k.label as string
              )
            )
          );
        }
        break;

      case "general":
      default:
        // Show everything
        options = [
          ...tableCompletions,
          ...functionCompletions,
          ...keywordCompletions,
        ];

        // Also add columns from tables in query
        {
          const tables = extractTablesFromQuery(doc, schema);
          tables.forEach((tableSchema, alias) => {
            const prefix = tables.size > 1 ? alias : undefined;
            options.push(...createColumnCompletions(tableSchema, prefix));
          });
        }
        break;
    }

    return {
      from,
      options,
      validFor: /^[\w.']*$/,
    };
  };
}

