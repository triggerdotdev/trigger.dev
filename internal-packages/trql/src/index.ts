// TRQL - Type-Safe SQL Query Language for ClickHouse
// Originally derived from PostHog's HogQL (see NOTICE.md for attribution)

import { CharStreams, CommonTokenStream } from "antlr4ts";
import type { ANTLRErrorListener, RecognitionException, Recognizer } from "antlr4ts";
import type { Token } from "antlr4ts/Token";
import { TRQLLexer } from "./grammar/TRQLLexer";
import { TRQLParser } from "./grammar/TRQLParser";
import { TRQLParseTreeConverter } from "./query/parser.js";
import type { SelectQuery, SelectSetQuery, Expression } from "./query/ast.js";
import { SyntaxError } from "./query/errors.js";
import { createSchemaRegistry, type TableSchema, type FieldMappings } from "./query/schema.js";
import { createPrinterContext, type QuerySettings } from "./query/printer_context.js";
import { printToClickHouse, type PrintResult } from "./query/printer.js";

/**
 * Simple error listener that captures syntax errors
 */
class TRQLErrorListener implements ANTLRErrorListener<Token> {
  public error: string | null = null;

  syntaxError(
    _recognizer: Recognizer<Token, any>,
    _offendingSymbol: Token | undefined,
    line: number,
    charPositionInLine: number,
    msg: string,
    _e: RecognitionException | undefined
  ): void {
    this.error = `Syntax error at line ${line}:${charPositionInLine}: ${msg}`;
  }
}

// Re-export AST types
export * from "./query/ast.js";

// Re-export errors
export * from "./query/errors.js";

// Re-export escape utilities
export {
  escapeClickHouseIdentifier,
  escapeTRQLIdentifier,
  escapeClickHouseString,
  escapeTRQLString,
  getClickHouseType,
} from "./query/escape.js";

// Re-export function definitions
export {
  TRQL_CLICKHOUSE_FUNCTIONS,
  TRQL_AGGREGATIONS,
  TRQL_COMPARISON_MAPPING,
  findTRQLAggregation,
  findTRQLFunction,
  getAllExposedFunctionNames,
  type TRQLFunctionMeta,
} from "./query/functions.js";

// Re-export schema types and functions
export {
  type TableSchema,
  type ColumnSchema,
  type TenantColumnConfig,
  type SchemaRegistry,
  type ClickHouseType,
  type OutputColumnMetadata,
  type FieldMappings,
  createSchemaRegistry,
  findTable,
  findColumn,
  validateTable,
  validateSelectColumn,
  validateFilterColumn,
  validateSortColumn,
  validateGroupColumn,
  column,
  // Value mapping utilities
  getUserFriendlyValue,
  getInternalValue,
  getAllowedUserValues,
  isValidUserValue,
  // Virtual column utilities
  isVirtualColumn,
  getVirtualColumnExpression,
  // Field mapping utilities (runtime dynamic mappings)
  hasFieldMapping,
  getExternalValue,
  getInternalValueFromMapping,
  getInternalValueFromMappingCaseInsensitive,
} from "./query/schema.js";

// Re-export printer context
export {
  PrinterContext,
  createPrinterContext,
  type PrinterContextOptions,
  type QuerySettings,
  type QueryNotice,
  DEFAULT_QUERY_SETTINGS,
} from "./query/printer_context.js";

// Re-export printer
export { ClickHousePrinter, printToClickHouse, type PrintResult } from "./query/printer.js";

// Re-export parser converter for advanced usage
export { TRQLParseTreeConverter } from "./query/parser.js";

// Re-export validator
export {
  validateQuery,
  type ValidationResult,
  type ValidationIssue,
  type ValidationSeverity,
} from "./query/validator.js";

// Re-export result transformation utilities
export {
  transformResults,
  createResultTransformer,
  type TransformResultsOptions,
} from "./query/results.js";

/**
 * Parse a TRQL SELECT query string into an AST
 *
 * @param query - The TRQL query string to parse
 * @returns The parsed AST (SelectQuery or SelectSetQuery)
 * @throws SyntaxError if the query is invalid
 *
 * @example
 * ```typescript
 * const ast = parseTRQLSelect("SELECT * FROM users WHERE id = 1");
 * ```
 */
export function parseTRQLSelect(query: string): SelectQuery | SelectSetQuery {
  const inputStream = CharStreams.fromString(query);
  const lexer = new TRQLLexer(inputStream);
  const tokenStream = new CommonTokenStream(lexer);
  const parser = new TRQLParser(tokenStream);

  // Remove default error listeners and add custom one
  parser.removeErrorListeners();
  const errorListener = new TRQLErrorListener();
  parser.addErrorListener(errorListener);

  const parseTree = parser.select();

  if (errorListener.error) {
    throw new SyntaxError(errorListener.error);
  }

  const converter = new TRQLParseTreeConverter();
  const ast = converter.visit(parseTree);

  // Validate the result is a select query
  if (typeof ast === "string" || !("expression_type" in ast)) {
    throw new SyntaxError("Failed to parse SELECT query");
  }

  if (ast.expression_type !== "select_query" && ast.expression_type !== "select_set_query") {
    throw new SyntaxError(`Expected SELECT query, got ${ast.expression_type}`);
  }

  return ast as SelectQuery | SelectSetQuery;
}

/**
 * Parse a TRQL expression string into an AST
 *
 * @param expr - The TRQL expression string to parse
 * @returns The parsed expression AST
 * @throws SyntaxError if the expression is invalid
 *
 * @example
 * ```typescript
 * const ast = parseTRQLExpr("id = 1 AND name = 'test'");
 * ```
 */
export function parseTRQLExpr(expr: string): Expression {
  const inputStream = CharStreams.fromString(expr);
  const lexer = new TRQLLexer(inputStream);
  const tokenStream = new CommonTokenStream(lexer);
  const parser = new TRQLParser(tokenStream);

  // Remove default error listeners and add custom one
  parser.removeErrorListeners();
  const errorListener = new TRQLErrorListener();
  parser.addErrorListener(errorListener);

  const parseTree = parser.columnExpr(0);

  if (errorListener.error) {
    throw new SyntaxError(errorListener.error);
  }

  const converter = new TRQLParseTreeConverter();
  return converter.visit(parseTree) as Expression;
}

/**
 * Options for compiling a TRQL query to ClickHouse SQL
 */
export interface CompileTRQLOptions {
  /** The organization ID for tenant isolation (required) */
  organizationId: string;
  /** The project ID for tenant isolation (optional - omit to query across all projects) */
  projectId?: string;
  /** The environment ID for tenant isolation (optional - omit to query across all environments) */
  environmentId?: string;
  /** Schema definitions for allowed tables and columns */
  tableSchema: TableSchema[];
  /** Optional query settings */
  settings?: Partial<QuerySettings>;
  /**
   * Runtime field mappings for dynamic value translation.
   * Maps internal ClickHouse values to external user-facing values.
   *
   * @example
   * ```typescript
   * {
   *   project: { "cm12345": "my-project-ref" },
   * }
   * ```
   */
  fieldMappings?: FieldMappings;
}

/**
 * Compile a TRQL query string to ClickHouse SQL with parameters
 *
 * This function:
 * 1. Parses the TRQL query into an AST
 * 2. Validates tables and columns against the schema
 * 3. Injects tenant isolation WHERE clauses
 * 4. Generates parameterized ClickHouse SQL
 *
 * @param query - The TRQL query string to compile
 * @param options - Compilation options including tenant IDs and schema
 * @returns The compiled SQL and parameters
 * @throws SyntaxError if the query is invalid
 * @throws QueryError if tables/columns are not allowed
 *
 * @example
 * ```typescript
 * const { sql, params } = compileTRQL(
 *   "SELECT * FROM task_runs WHERE status = 'completed' LIMIT 100",
 *   {
 *     organizationId: "org_123",
 *     projectId: "proj_456",
 *     environmentId: "env_789",
 *     tableSchema: [taskRunsSchema],
 *   }
 * );
 * ```
 */
export function compileTRQL(query: string, options: CompileTRQLOptions): PrintResult {
  // 1. Parse the TRQL query
  const ast = parseTRQLSelect(query);

  // 2. Create schema registry from table schemas
  const schemaRegistry = createSchemaRegistry(options.tableSchema);

  // 3. Create printer context with tenant IDs and field mappings
  const context = createPrinterContext({
    organizationId: options.organizationId,
    projectId: options.projectId,
    environmentId: options.environmentId,
    schema: schemaRegistry,
    settings: options.settings,
    fieldMappings: options.fieldMappings,
  });

  // 4. Print the AST to ClickHouse SQL
  return printToClickHouse(ast, context);
}
