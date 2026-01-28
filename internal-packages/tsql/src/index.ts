// TSQL - Type-Safe SQL Query Language for ClickHouse
// Originally derived from PostHog's HogQL (see NOTICE.md for attribution)

import type { ANTLRErrorListener, RecognitionException, Recognizer } from "antlr4ts";
import { CharStreams, CommonTokenStream } from "antlr4ts";
import type { Token } from "antlr4ts/Token";
import { TSQLLexer } from "./grammar/TSQLLexer.js";
import { TSQLParser } from "./grammar/TSQLParser.js";
import type {
  And,
  BetweenExpr,
  Call,
  CompareOperation,
  Constant,
  Expression,
  Field,
  Not,
  Or,
  SelectQuery,
  SelectSetQuery,
} from "./query/ast.js";
import { CompareOperationOp } from "./query/ast.js";
import { SyntaxError as TSQLSyntaxError } from "./query/errors.js";
import { TSQLParseTreeConverter } from "./query/parser.js";
import { printToClickHouse, type PrintResult } from "./query/printer.js";
import {
  createPrinterContext,
  type BetweenCondition,
  type QuerySettings,
  type SimpleComparisonCondition,
  type WhereClauseCondition,
} from "./query/printer_context.js";
import { createSchemaRegistry, type FieldMappings, type TableSchema } from "./query/schema.js";

/**
 * Simple error listener that captures syntax errors
 */
class TSQLErrorListener implements ANTLRErrorListener<Token> {
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
  escapeClickHouseString,
  escapeTSQLIdentifier,
  escapeTSQLString,
  getClickHouseType,
} from "./query/escape.js";

// Re-export function definitions
export {
  findTSQLAggregation,
  findTSQLFunction,
  getAllExposedFunctionNames,
  TSQL_AGGREGATIONS,
  TSQL_CLICKHOUSE_FUNCTIONS,
  TSQL_COMPARISON_MAPPING,
  type TSQLFunctionMeta,
} from "./query/functions.js";

// Re-export schema types and functions
export {
  column,
  createSchemaRegistry,
  findColumn,
  findTable,
  getAllowedUserValues,
  // Core column utilities
  getCoreColumns,
  getExternalValue,
  getInternalValue,
  getInternalValueFromMapping,
  getInternalValueFromMappingCaseInsensitive,
  // Value mapping utilities
  getUserFriendlyValue,
  getVirtualColumnExpression,
  // Field mapping utilities (runtime dynamic mappings)
  hasFieldMapping,
  isValidUserValue,
  // Virtual column utilities
  isVirtualColumn,
  // Error message sanitization
  sanitizeErrorMessage,
  validateFilterColumn,
  validateGroupColumn,
  validateSelectColumn,
  validateSortColumn,
  validateTable,
  type ClickHouseType,
  type ColumnSchema,
  type FieldMappings,
  type OutputColumnMetadata,
  type RequiredFilter,
  type SchemaRegistry,
  type TableSchema,
  type TenantColumnConfig,
} from "./query/schema.js";

// Re-export printer context
export {
  createPrinterContext,
  DEFAULT_QUERY_SETTINGS,
  PrinterContext,
  type BetweenCondition,
  type PrinterContextOptions,
  type QueryNotice,
  type QuerySettings,
  type SimpleComparisonCondition,
  type WhereClauseCondition,
} from "./query/printer_context.js";

// Re-export printer
export { ClickHousePrinter, printToClickHouse, type PrintResult } from "./query/printer.js";

// Re-export parser converter for advanced usage
export { TSQLParseTreeConverter } from "./query/parser.js";

// Re-export validator
export {
  validateQuery,
  type ValidationIssue,
  type ValidationResult,
  type ValidationSeverity,
} from "./query/validator.js";

// Re-export result transformation utilities
export {
  createResultTransformer,
  transformResults,
  type TransformResultsOptions,
} from "./query/results.js";

/**
 * Parse a TSQL SELECT query string into an AST
 *
 * @param query - The TSQL query string to parse
 * @returns The parsed AST (SelectQuery or SelectSetQuery)
 * @throws TSQLSyntaxError if the query is invalid
 *
 * @example
 * ```typescript
 * const ast = parseTSQLSelect("SELECT * FROM users WHERE id = 1");
 * ```
 */
export function parseTSQLSelect(query: string): SelectQuery | SelectSetQuery {
  const inputStream = CharStreams.fromString(query);
  const lexer = new TSQLLexer(inputStream);
  const tokenStream = new CommonTokenStream(lexer);
  const parser = new TSQLParser(tokenStream);

  // Remove default error listeners and add custom one
  parser.removeErrorListeners();
  const errorListener = new TSQLErrorListener();
  parser.addErrorListener(errorListener);

  const parseTree = parser.select();

  if (errorListener.error) {
    throw new TSQLSyntaxError(errorListener.error);
  }

  const converter = new TSQLParseTreeConverter();
  const ast = converter.visit(parseTree);

  // Validate the result is a select query
  if (typeof ast === "string" || !("expression_type" in ast)) {
    throw new TSQLSyntaxError("Failed to parse SELECT query");
  }

  if (ast.expression_type !== "select_query" && ast.expression_type !== "select_set_query") {
    throw new TSQLSyntaxError(`Expected SELECT query, got ${ast.expression_type}`);
  }

  return ast as SelectQuery | SelectSetQuery;
}

/**
 * Parse a TSQL expression string into an AST
 *
 * @param expr - The TSQL expression string to parse
 * @returns The parsed expression AST
 * @throws TSQLSyntaxError if the expression is invalid
 *
 * @example
 * ```typescript
 * const ast = parseTSQLExpr("id = 1 AND name = 'test'");
 * ```
 */
export function parseTSQLExpr(expr: string): Expression {
  const inputStream = CharStreams.fromString(expr);
  const lexer = new TSQLLexer(inputStream);
  const tokenStream = new CommonTokenStream(lexer);
  const parser = new TSQLParser(tokenStream);

  // Remove default error listeners and add custom one
  parser.removeErrorListeners();
  const errorListener = new TSQLErrorListener();
  parser.addErrorListener(errorListener);

  const parseTree = parser.columnExpr(0);

  if (errorListener.error) {
    throw new TSQLSyntaxError(errorListener.error);
  }

  const converter = new TSQLParseTreeConverter();
  return converter.visit(parseTree) as Expression;
}

/**
 * Check if a column is referenced in an expression (for WHERE clause detection).
 * Recursively traverses And, Or, CompareOperation, BetweenExpr, and Field nodes.
 *
 * @param expr - The expression to search
 * @param column - The column name to look for
 * @returns true if the column is referenced in the expression
 */
export function isColumnReferencedInExpression(
  expr: Expression | undefined,
  column: string
): boolean {
  if (!expr) return false;

  const exprType = (expr as Expression).expression_type;

  switch (exprType) {
    case "and": {
      const andExpr = expr as And;
      return andExpr.exprs.some((e) => isColumnReferencedInExpression(e, column));
    }
    case "or": {
      const orExpr = expr as Or;
      return orExpr.exprs.some((e) => isColumnReferencedInExpression(e, column));
    }
    case "compare_operation": {
      const compareExpr = expr as CompareOperation;
      return (
        isColumnReferencedInExpression(compareExpr.left, column) ||
        isColumnReferencedInExpression(compareExpr.right, column)
      );
    }
    case "between_expr": {
      const betweenExpr = expr as BetweenExpr;
      return isColumnReferencedInExpression(betweenExpr.expr, column);
    }
    case "field": {
      const fieldExpr = expr as Field;
      // Check if any part of the chain matches the column name
      // Handles both unqualified (column) and qualified (table.column) references
      return fieldExpr.chain.some((part) => part === column);
    }
    case "not": {
      const notExpr = expr as Not;
      return isColumnReferencedInExpression(notExpr.expr, column);
    }
    default:
      return false;
  }
}

/**
 * Format a Date as a ClickHouse-compatible DateTime64 string.
 * ClickHouse expects format: 'YYYY-MM-DD HH:MM:SS.mmm' (in UTC)
 */
function formatDateForClickHouse(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  const ms = String(date.getUTCMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

/**
 * Create an AST expression for a fallback value.
 * Date values are wrapped in toDateTime64() for ClickHouse compatibility.
 */
function createValueExpression(value: Date | string | number): Expression {
  if (value instanceof Date) {
    // Wrap Date in toDateTime64(formatted_string, 3) for ClickHouse DateTime64(3) columns
    return {
      expression_type: "call",
      name: "toDateTime64",
      args: [
        { expression_type: "constant", value: formatDateForClickHouse(value) } as Constant,
        { expression_type: "constant", value: 3 } as Constant,
      ],
    } as Call;
  }
  return { expression_type: "constant", value } as Constant;
}

/**
 * Map fallback operator to CompareOperationOp
 */
function mapFallbackOpToCompareOp(op: SimpleComparisonCondition["op"]): CompareOperationOp {
  switch (op) {
    case "eq":
      return CompareOperationOp.Eq;
    case "neq":
      return CompareOperationOp.NotEq;
    case "gt":
      return CompareOperationOp.Gt;
    case "gte":
      return CompareOperationOp.GtEq;
    case "lt":
      return CompareOperationOp.Lt;
    case "lte":
      return CompareOperationOp.LtEq;
  }
}

/**
 * Create an AST expression from a fallback condition
 *
 * @param column - The column name
 * @param fallback - The fallback condition
 * @returns The AST expression for the fallback condition
 */
export function createFallbackExpression(
  column: string,
  fallback: WhereClauseCondition
): Expression {
  const fieldExpr: Field = {
    expression_type: "field",
    chain: [column],
  };

  if (fallback.op === "between") {
    const betweenExpr: BetweenExpr = {
      expression_type: "between_expr",
      expr: fieldExpr,
      low: createValueExpression(fallback.low),
      high: createValueExpression(fallback.high),
    };
    return betweenExpr;
  }

  // Simple comparison
  const compareExpr: CompareOperation = {
    expression_type: "compare_operation",
    left: fieldExpr,
    right: createValueExpression(fallback.value),
    op: mapFallbackOpToCompareOp(fallback.op),
  };
  return compareExpr;
}

/**
 * Inject fallback WHERE conditions into a parsed AST.
 * Only adds fallback conditions for columns not already referenced in the WHERE clause.
 *
 * @param ast - The parsed SELECT query AST
 * @param fallbacks - The fallback conditions to potentially inject
 * @returns The modified AST with fallback conditions injected
 */
export function injectFallbackConditions(
  ast: SelectQuery | SelectSetQuery,
  fallbacks: Record<string, WhereClauseCondition>
): SelectQuery | SelectSetQuery {
  // Handle SelectSetQuery (UNION, etc.) - apply to each query in the set
  if (ast.expression_type === "select_set_query") {
    const setQuery = ast as SelectSetQuery;
    // Process the initial select query
    const modifiedInitial = injectFallbackConditions(
      setQuery.initial_select_query,
      fallbacks
    ) as SelectQuery;

    // Process subsequent queries
    const modifiedSubsequent = setQuery.subsequent_select_queries.map((sq) => ({
      ...sq,
      select_query: injectFallbackConditions(sq.select_query, fallbacks) as SelectQuery,
    }));

    return {
      ...setQuery,
      initial_select_query: modifiedInitial,
      subsequent_select_queries: modifiedSubsequent,
    };
  }

  // Handle SelectQuery
  const selectQuery = ast as SelectQuery;
  const existingWhere = selectQuery.where;

  // Collect fallback expressions for columns not already in WHERE
  const fallbackExprs: Expression[] = [];
  for (const [column, fallback] of Object.entries(fallbacks)) {
    if (!isColumnReferencedInExpression(existingWhere, column)) {
      fallbackExprs.push(createFallbackExpression(column, fallback));
    }
  }

  // If no fallbacks to add, return original AST
  if (fallbackExprs.length === 0) {
    return ast;
  }

  // Combine fallbacks with existing WHERE using AND
  let newWhere: Expression;
  if (!existingWhere) {
    // No existing WHERE - just use fallbacks
    if (fallbackExprs.length === 1) {
      newWhere = fallbackExprs[0];
    } else {
      newWhere = {
        expression_type: "and",
        exprs: fallbackExprs,
      } as And;
    }
  } else {
    // Combine existing WHERE with fallbacks
    newWhere = {
      expression_type: "and",
      exprs: [...fallbackExprs, existingWhere],
    } as And;
  }

  return {
    ...selectQuery,
    where: newWhere,
  };
}


/**
 * Options for compiling a TSQL query to ClickHouse SQL
 */
export interface CompileTSQLOptions {
  /** Schema definitions for allowed tables and columns */
  tableSchema: TableSchema[];
  /**
   * REQUIRED: Conditions always applied at the table level.
   * Must include tenant columns (e.g., organization_id) for multi-tenant tables.
   * Applied to every table reference including subqueries, CTEs, and JOINs.
   *
   * @example
   * ```typescript
   * {
   *   // Tenant isolation
   *   organization_id: { op: "eq", value: "org_123" },
   *   project_id: { op: "eq", value: "proj_456" },
   *   environment_id: { op: "eq", value: "env_789" },
   *   // Plan-based time limit
   *   triggered_at: { op: "gte", value: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
   * }
   * ```
   */
  enforcedWhereClause: Record<string, WhereClauseCondition | undefined>;
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
  /**
   * Fallback WHERE conditions to apply when the user hasn't filtered on a column.
   * Key is the column name, value is the fallback condition.
   * These are applied at the AST level (top-level query only).
   *
   * @example
   * ```typescript
   * // Apply time > 7 days ago if user doesn't filter on time
   * whereClauseFallback: {
   *   time: { op: 'gte', value: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }
   * }
   *
   * // Apply time BETWEEN two dates if user doesn't filter on time
   * whereClauseFallback: {
   *   time: { op: 'between', low: startDate, high: endDate }
   * }
   * ```
   */
  whereClauseFallback?: Record<string, WhereClauseCondition>;
}

/**
 * Compile a TSQL query string to ClickHouse SQL with parameters
 *
 * This function:
 * 1. Parses the TSQL query into an AST
 * 2. Validates tables and columns against the schema
 * 3. Injects enforced WHERE clauses (tenant isolation + plan limits) at printer level
 * 4. Optionally injects fallback WHERE conditions at AST level
 * 5. Generates parameterized ClickHouse SQL
 *
 * @param query - The TSQL query string to compile
 * @param options - Compilation options including enforcedWhereClause and schema
 * @returns The compiled SQL and parameters
 * @throws TSQLSyntaxError if the query is invalid
 * @throws QueryError if tables/columns are not allowed or required tenant columns are missing
 *
 * @example
 * ```typescript
 * const { sql, params } = compileTSQL(
 *   "SELECT * FROM task_runs WHERE status = 'completed' LIMIT 100",
 *   {
 *     tableSchema: [taskRunsSchema],
 *     enforcedWhereClause: {
 *       organization_id: { op: "eq", value: "org_123" },
 *       project_id: { op: "eq", value: "proj_456" },
 *       environment_id: { op: "eq", value: "env_789" },
 *       triggered_at: { op: "gte", value: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
 *     },
 *   }
 * );
 * ```
 */
export function compileTSQL(query: string, options: CompileTSQLOptions): PrintResult {
  // 1. Parse the TSQL query
  let ast = parseTSQLSelect(query);

  // 2. Inject fallback WHERE conditions if provided (applied at AST level - top-level query only)
  if (options.whereClauseFallback && Object.keys(options.whereClauseFallback).length > 0) {
    ast = injectFallbackConditions(ast, options.whereClauseFallback);
  }

  // 3. Create schema registry from table schemas
  const schemaRegistry = createSchemaRegistry(options.tableSchema);


  // 4. Strip undefined values from enforcedWhereClause
  const enforcedWhereClause = Object.fromEntries(
    Object.entries(options.enforcedWhereClause).filter(([_, value]) => value !== undefined)
  ) as Record<string, WhereClauseCondition>;

  // 5. Create printer context with enforced WHERE clause and field mappings
  const context = createPrinterContext({
    schema: schemaRegistry,
    settings: options.settings,
    fieldMappings: options.fieldMappings,
    enforcedWhereClause,
  });

  // 6. Print the AST to ClickHouse SQL (enforced conditions applied at printer level)
  return printToClickHouse(ast, context);
}
