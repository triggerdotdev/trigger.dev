// TSQL - Type-Safe SQL Query Language
// A TypeScript port of PostHog's HogQL for ClickHouse queries

import { CharStreams, CommonTokenStream } from "antlr4ts";
import type { ANTLRErrorListener, RecognitionException, Recognizer } from "antlr4ts";
import type { Token } from "antlr4ts/Token";
import { TSQLLexer } from "./grammar/TSQLLexer.js";
import { TSQLParser } from "./grammar/TSQLParser.js";
import { TSQLParseTreeConverter } from "./query/parser.js";
import type { SelectQuery, SelectSetQuery, Expression } from "./query/ast.js";
import { SyntaxError } from "./query/errors.js";

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
  escapeTSQLIdentifier,
  escapeClickHouseString,
  escapeTSQLString,
  getClickHouseType,
} from "./query/escape.js";

// Re-export function definitions
export {
  TSQL_CLICKHOUSE_FUNCTIONS,
  TSQL_AGGREGATIONS,
  TSQL_COMPARISON_MAPPING,
  findTSQLAggregation,
  findTSQLFunction,
  getAllExposedFunctionNames,
  type TSQLFunctionMeta,
} from "./query/functions.js";

// Re-export schema types and functions
export {
  type TableSchema,
  type ColumnSchema,
  type TenantColumnConfig,
  type SchemaRegistry,
  type ClickHouseType,
  createSchemaRegistry,
  findTable,
  findColumn,
  validateTable,
  validateSelectColumn,
  validateFilterColumn,
  validateSortColumn,
  validateGroupColumn,
  column,
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
export { TSQLParseTreeConverter } from "./query/parser.js";

/**
 * Parse a TSQL SELECT query string into an AST
 *
 * @param query - The TSQL query string to parse
 * @returns The parsed AST (SelectQuery or SelectSetQuery)
 * @throws SyntaxError if the query is invalid
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
    throw new SyntaxError(errorListener.error);
  }

  const converter = new TSQLParseTreeConverter();
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
 * Parse a TSQL expression string into an AST
 *
 * @param expr - The TSQL expression string to parse
 * @returns The parsed expression AST
 * @throws SyntaxError if the expression is invalid
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
    throw new SyntaxError(errorListener.error);
  }

  const converter = new TSQLParseTreeConverter();
  return converter.visit(parseTree) as Expression;
}
