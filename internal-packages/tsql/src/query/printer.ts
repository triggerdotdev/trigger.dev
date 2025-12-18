// TypeScript port of posthog/hogql/printer.py
// ClickHouse SQL printer with tenant isolation and schema validation

import {
  And,
  Alias,
  ArithmeticOperation,
  ArithmeticOperationOp,
  Array as ASTArray,
  ArrayAccess,
  AST,
  BetweenExpr,
  Call,
  CompareOperation,
  CompareOperationOp,
  Constant,
  CTE,
  Dict,
  Expression,
  Field,
  JoinConstraint,
  JoinExpr,
  Lambda,
  LimitByExpr,
  Not,
  Or,
  OrderExpr,
  Placeholder,
  RatioExpr,
  SampleExpr,
  SelectQuery,
  SelectSetQuery,
  Tuple,
  TupleAccess,
  WindowExpr,
  WindowFrameExpr,
  WindowFunction,
} from "./ast";
import { escapeClickHouseIdentifier, escapeTSQLIdentifier, escapeClickHouseString } from "./escape";
import { ImpossibleASTError, NotImplementedError, QueryError } from "./errors";
import {
  TSQL_CLICKHOUSE_FUNCTIONS,
  TSQL_AGGREGATIONS,
  TSQL_COMPARISON_MAPPING,
  findTSQLAggregation,
  findTSQLFunction,
  validateFunctionArgs,
} from "./functions";
import { PrinterContext } from "./printer_context";
import {
  findTable,
  validateTable,
  TableSchema,
  ColumnSchema,
  getInternalValue,
  isVirtualColumn,
  OutputColumnMetadata,
  ClickHouseType,
} from "./schema";

/**
 * Result of printing an AST to ClickHouse SQL
 */
export interface PrintResult {
  /** The generated ClickHouse SQL query */
  sql: string;
  /** Parameter values for parameterized query execution */
  params: Record<string, unknown>;
  /** Metadata for each column in the SELECT clause, in order */
  columns: OutputColumnMetadata[];
}

/**
 * Response from visiting a JoinExpr node
 */
interface JoinExprResponse {
  /** The printed SQL for the JOIN */
  printedSql: string;
  /** Additional WHERE clause to add (e.g., tenant isolation guards) */
  where: Expression | null;
}

/**
 * ClickHouse SQL Printer
 *
 * Converts a TSQL AST to a parameterized ClickHouse SQL query with:
 * - Automatic tenant isolation (organization_id, project_id, environment_id)
 * - Schema-based table/column validation
 * - SQL injection protection via parameterized queries
 * - Table and column name mapping (user-friendly → internal ClickHouse names)
 */
export class ClickHousePrinter {
  /** Stack of AST nodes being visited (for context) */
  private stack: AST[] = [];
  /** Indent level for pretty printing */
  private indentLevel = -1;
  /** Tab size for pretty printing */
  private tabSize = 4;
  /** Whether to pretty print output */
  private pretty: boolean;
  /**
   * Map of table aliases to their schemas (for column name resolution)
   * Key is the alias/name used in the query, value is the TableSchema
   */
  private tableContexts: Map<string, TableSchema> = new Map();
  /** Column metadata collected during SELECT processing */
  private outputColumns: OutputColumnMetadata[] = [];

  constructor(
    private context: PrinterContext,
    options: { pretty?: boolean } = {}
  ) {
    this.pretty = options.pretty ?? false;
  }

  /**
   * Print an AST node to ClickHouse SQL
   */
  print(node: SelectQuery | SelectSetQuery): PrintResult {
    this.outputColumns = [];
    const sql = this.visit(node);
    return {
      sql,
      params: this.context.getParams(),
      columns: this.outputColumns,
    };
  }

  /**
   * Get current indentation string
   */
  private indent(extra = 0): string {
    return " ".repeat(this.tabSize * (this.indentLevel + extra));
  }

  /**
   * Visit an AST node and return its SQL representation
   */
  private visit(node: AST | null | undefined): string {
    if (node === null || node === undefined) {
      return "";
    }

    this.stack.push(node);
    this.indentLevel++;

    let response: string;

    // Type-based dispatch
    const nodeType = (node as Expression).expression_type;

    switch (nodeType) {
      case "select_set_query":
        response = this.visitSelectSetQuery(node as SelectSetQuery);
        break;
      case "select_query":
        response = this.visitSelectQuery(node as SelectQuery);
        break;
      case "cte":
        response = this.visitCTE(node as CTE);
        break;
      case "alias":
        response = this.visitAlias(node as Alias);
        break;
      case "arithmetic_operation":
        response = this.visitArithmeticOperation(node as ArithmeticOperation);
        break;
      case "and":
        response = this.visitAnd(node as And);
        break;
      case "or":
        response = this.visitOr(node as Or);
        break;
      case "compare_operation":
        response = this.visitCompareOperation(node as CompareOperation);
        break;
      case "not":
        response = this.visitNot(node as Not);
        break;
      case "between_expr":
        response = this.visitBetweenExpr(node as BetweenExpr);
        break;
      case "order_expr":
        response = this.visitOrderExpr(node as OrderExpr);
        break;
      case "array_access":
        response = this.visitArrayAccess(node as ArrayAccess);
        break;
      case "array":
        response = this.visitArray(node as ASTArray);
        break;
      case "dict":
        response = this.visitDict(node as Dict);
        break;
      case "tuple_access":
        response = this.visitTupleAccess(node as TupleAccess);
        break;
      case "tuple":
        response = this.visitTuple(node as Tuple);
        break;
      case "lambda":
        response = this.visitLambda(node as Lambda);
        break;
      case "constant":
        response = this.visitConstant(node as Constant);
        break;
      case "field":
        response = this.visitField(node as Field);
        break;
      case "placeholder":
        response = this.visitPlaceholder(node as Placeholder);
        break;
      case "call":
        response = this.visitCall(node as Call);
        break;
      case "join_expr":
        // JoinExpr is handled specially since it returns more than just SQL
        throw new ImpossibleASTError("JoinExpr should be handled via visitJoinExpr");
      case "join_constraint":
        response = this.visitJoinConstraint(node as JoinConstraint);
        break;
      case "window_frame_expr":
        response = this.visitWindowFrameExpr(node as WindowFrameExpr);
        break;
      case "window_expr":
        response = this.visitWindowExpr(node as WindowExpr);
        break;
      case "window_function":
        response = this.visitWindowFunction(node as WindowFunction);
        break;
      case "limit_by_expr":
        response = this.visitLimitByExpr(node as LimitByExpr);
        break;
      case "ratio_expr":
        response = this.visitRatioExpr(node as RatioExpr);
        break;
      case "sample_expr":
        response = this.visitSampleExpr(node as SampleExpr);
        break;
      default:
        throw new NotImplementedError(`Unknown expression type: ${nodeType}`);
    }

    this.indentLevel--;
    this.stack.pop();

    return response;
  }

  // ============================================================
  // SELECT Query Visitors
  // ============================================================

  private visitSelectSetQuery(node: SelectSetQuery): string {
    this.indentLevel--;
    let ret = this.visit(node.initial_select_query);
    if (this.pretty) {
      ret = ret.trim();
    }

    for (const expr of node.subsequent_select_queries) {
      let query = this.visit(expr.select_query);
      if (this.pretty) {
        query = query.trim();
      }
      if (expr.set_operator !== undefined) {
        if (this.pretty) {
          ret += `\n${this.indent(1)}${expr.set_operator}\n${this.indent(1)}`;
        } else {
          ret += ` ${expr.set_operator} `;
        }
      }
      ret += query;
    }

    this.indentLevel++;

    // Wrap in parentheses if not top level
    if (this.stack.length > 1) {
      return `(${ret.trim()})`;
    }
    return ret;
  }

  private visitSelectQuery(node: SelectQuery): string {
    // Determine if this is a top-level query
    const partOfSelectUnion =
      this.stack.length >= 2 && this.isSelectSetQuery(this.stack[this.stack.length - 2]);
    const isTopLevelQuery =
      this.stack.length <= 1 || (this.stack.length === 2 && partOfSelectUnion);

    // Clear table contexts for top-level queries (subqueries inherit parent context)
    if (isTopLevelQuery) {
      this.tableContexts.clear();
    }

    // Build WHERE clause starting with any existing where
    let where: Expression | undefined = node.where;

    // Process CTEs
    const cteStrings: string[] = [];
    if (node.ctes) {
      for (const [name, cte] of Object.entries(node.ctes)) {
        cteStrings.push(`${this.printIdentifier(name)} AS (${this.visit(cte.expr)})`);
      }
    }

    // Process joins and collect tenant guards
    const joinedTables: string[] = [];
    let nextJoin: JoinExpr | undefined = node.select_from;

    while (nextJoin) {
      const visitedJoin = this.visitJoinExpr(nextJoin);
      joinedTables.push(visitedJoin.printedSql);

      // Add tenant guard to WHERE clause
      const extraWhere = visitedJoin.where;
      if (extraWhere !== null) {
        if (where === undefined) {
          where = extraWhere;
        } else if ((where as And).expression_type === "and") {
          where = { expression_type: "and", exprs: [extraWhere, ...(where as And).exprs] } as And;
        } else {
          where = { expression_type: "and", exprs: [extraWhere, where] } as And;
        }
      }

      nextJoin = nextJoin.next_join;
    }

    // Process SELECT columns and collect metadata
    let columns: string[];
    if (node.select && node.select.length > 0) {
      // Only collect metadata for top-level queries (not subqueries)
      if (isTopLevelQuery) {
        this.outputColumns = [];
      }
      columns = node.select.map((col) => this.visitSelectColumnWithMetadata(col, isTopLevelQuery));
    } else {
      columns = ["1"];
    }

    // Process WINDOW definitions
    let windowClause: string | null = null;
    if (node.window_exprs && Object.keys(node.window_exprs).length > 0) {
      const windowDefs = Object.entries(node.window_exprs).map(
        ([name, expr]) => `${this.printIdentifier(name)} AS (${this.visit(expr)})`
      );
      windowClause = windowDefs.join(", ");
    }

    // Process other clauses
    const prewhere = node.prewhere ? this.visit(node.prewhere) : null;
    const whereStr = where ? this.visit(where) : null;
    const groupBy = node.group_by ? node.group_by.map((col) => this.visit(col)) : null;
    const having = node.having ? this.visit(node.having) : null;
    const orderBy = node.order_by ? node.order_by.map((col) => this.visit(col)) : null;

    // Process ARRAY JOIN
    let arrayJoin = "";
    if (node.array_join_op) {
      if (!["ARRAY JOIN", "LEFT ARRAY JOIN", "INNER ARRAY JOIN"].includes(node.array_join_op)) {
        throw new ImpossibleASTError(`Invalid ARRAY JOIN operation: ${node.array_join_op}`);
      }
      arrayJoin = node.array_join_op;
      if (!node.array_join_list || node.array_join_list.length === 0) {
        throw new ImpossibleASTError("Invalid ARRAY JOIN without an array");
      }
      arrayJoin += ` ${node.array_join_list.map((expr) => this.visit(expr)).join(", ")}`;
    }

    // Format spacing
    const space = this.pretty ? `\n${this.indent(1)}` : " ";
    const comma = this.pretty ? `,\n${this.indent(1)}` : ", ";

    // Build SQL clauses
    const clauses: (string | null)[] = [
      `SELECT${space}${node.distinct ? "DISTINCT " : ""}${columns.join(comma)}`,
      joinedTables.length > 0 ? `FROM${space}${joinedTables.join(space)}` : null,
      arrayJoin || null,
      prewhere ? `PREWHERE${space}${prewhere}` : null,
      whereStr ? `WHERE${space}${whereStr}` : null,
      groupBy && groupBy.length > 0 ? `GROUP BY${space}${groupBy.join(comma)}` : null,
      having ? `HAVING${space}${having}` : null,
      windowClause ? `WINDOW${space}${windowClause}` : null,
      orderBy && orderBy.length > 0 ? `ORDER BY${space}${orderBy.join(comma)}` : null,
    ];

    // Process LIMIT
    let limit = node.limit;
    if (isTopLevelQuery && this.context.maxRows) {
      const maxLimit = this.context.maxRows;
      if (limit !== undefined) {
        // Cap the limit to maxRows
        if ((limit as Constant).expression_type === "constant") {
          const constLimit = limit as Constant;
          if (typeof constLimit.value === "number") {
            constLimit.value = Math.min(constLimit.value, maxLimit);
          }
        }
      } else {
        // Add default limit
        limit = { expression_type: "constant", value: maxLimit } as Constant;
      }
    }

    // Add LIMIT BY
    if (node.limit_by) {
      const limitByExprs = node.limit_by.exprs.map((e) => this.visit(e)).join(", ");
      const offsetPart = node.limit_by.offset_value
        ? ` OFFSET ${this.visit(node.limit_by.offset_value)}`
        : "";
      clauses.push(`LIMIT ${this.visit(node.limit_by.n)}${offsetPart} BY ${limitByExprs}`);
    }

    // Add LIMIT/OFFSET
    if (limit !== undefined) {
      clauses.push(`LIMIT ${this.visit(limit)}`);
      if (node.limit_with_ties) {
        clauses.push("WITH TIES");
      }
      if (node.offset !== undefined) {
        clauses.push(`OFFSET ${this.visit(node.offset)}`);
      }
    }

    // Add CTEs
    let response: string;
    if (this.pretty) {
      response = clauses
        .filter((c) => c !== null)
        .map((c) => `${this.indent()}${c}`)
        .join("\n");
    } else {
      response = clauses.filter((c) => c !== null).join(" ");
    }

    // Add WITH clause for CTEs
    if (cteStrings.length > 0) {
      const ctePrefix = `WITH ${cteStrings.join(", ")}`;
      response = `${ctePrefix} ${response}`;
    }

    // Wrap subqueries in parentheses
    if (!partOfSelectUnion && !isTopLevelQuery) {
      response = this.pretty ? `(${response.trim()})` : `(${response})`;
    }

    return response;
  }

  /**
   * Visit a SELECT column expression with metadata collection
   *
   * For bare Field expressions that reference virtual columns, we need to add
   * an AS alias to preserve the column name in the result set.
   *
   * Examples:
   * - `SELECT execution_duration` → `SELECT (expr) AS execution_duration`
   * - `SELECT execution_duration AS dur` → `SELECT (expr) AS dur` (Alias handles it)
   * - `SELECT run_id` → `SELECT run_id` (not a virtual column)
   *
   * @param col - The column expression
   * @param collectMetadata - Whether to collect column metadata (only for top-level queries)
   */
  private visitSelectColumnWithMetadata(col: Expression, collectMetadata: boolean): string {
    // Extract output name and source column before visiting
    const { outputName, sourceColumn, inferredType } = this.analyzeSelectColumn(col);

    // Check if this is a bare Field (not wrapped in Alias)
    let sqlResult: string;
    if ((col as Field).expression_type === "field") {
      const field = col as Field;
      const virtualColumnName = this.getVirtualColumnNameForField(field.chain);

      if (virtualColumnName !== null) {
        // Visit the field (which will return the expression)
        const visited = this.visit(col);
        // Add the alias to preserve the column name
        sqlResult = `${visited} AS ${this.printIdentifier(virtualColumnName)}`;
      } else {
        sqlResult = this.visit(col);
      }
    } else {
      // For non-virtual columns or expressions already wrapped in Alias, visit normally
      sqlResult = this.visit(col);
    }

    // Collect metadata for top-level queries
    if (collectMetadata && outputName) {
      const metadata: OutputColumnMetadata = {
        name: outputName,
        type: sourceColumn?.type ?? inferredType ?? "String",
      };

      // Only add customRenderType if specified in schema
      if (sourceColumn?.customRenderType) {
        metadata.customRenderType = sourceColumn.customRenderType;
      }

      this.outputColumns.push(metadata);
    }

    return sqlResult;
  }

  /**
   * Analyze a SELECT column expression to extract output name, source column, and type
   */
  private analyzeSelectColumn(col: Expression): {
    outputName: string | null;
    sourceColumn: ColumnSchema | null;
    inferredType: ClickHouseType | null;
  } {
    // Handle Alias - the output name is the alias
    if ((col as Alias).expression_type === "alias") {
      const alias = col as Alias;
      const innerAnalysis = this.analyzeSelectColumn(alias.expr);
      return {
        outputName: alias.alias,
        sourceColumn: innerAnalysis.sourceColumn,
        inferredType: innerAnalysis.inferredType,
      };
    }

    // Handle Field - the output name is the column name
    if ((col as Field).expression_type === "field") {
      const field = col as Field;
      const columnInfo = this.resolveFieldToColumn(field.chain);
      return {
        outputName: columnInfo.outputName,
        sourceColumn: columnInfo.column,
        inferredType: columnInfo.column?.type ?? null,
      };
    }

    // Handle Call (function/aggregation) - infer type from function
    if ((col as Call).expression_type === "call") {
      const call = col as Call;
      const inferredType = this.inferCallType(call);
      return {
        outputName: null, // Computed columns without alias get auto-named by ClickHouse
        sourceColumn: null,
        inferredType,
      };
    }

    // Handle ArithmeticOperation - infer type
    if ((col as ArithmeticOperation).expression_type === "arithmetic_operation") {
      const arith = col as ArithmeticOperation;
      const inferredType = this.inferArithmeticType(arith);
      return {
        outputName: null,
        sourceColumn: null,
        inferredType,
      };
    }

    // Handle Constant
    if ((col as Constant).expression_type === "constant") {
      const constant = col as Constant;
      const inferredType = this.inferConstantType(constant);
      return {
        outputName: null,
        sourceColumn: null,
        inferredType,
      };
    }

    // Default for other expression types
    return {
      outputName: null,
      sourceColumn: null,
      inferredType: null,
    };
  }

  /**
   * Resolve a field chain to its column schema and output name
   */
  private resolveFieldToColumn(chain: Array<string | number>): {
    outputName: string | null;
    column: ColumnSchema | null;
  } {
    if (chain.length === 0) {
      return { outputName: null, column: null };
    }

    // Handle asterisk
    if (chain[0] === "*" || (chain.length === 2 && chain[1] === "*")) {
      return { outputName: null, column: null };
    }

    const firstPart = chain[0];
    if (typeof firstPart !== "string") {
      return { outputName: null, column: null };
    }

    // Case 1: Qualified reference like table.column
    if (chain.length >= 2) {
      const tableAlias = firstPart;
      const tableSchema = this.tableContexts.get(tableAlias);
      if (!tableSchema) {
        return { outputName: firstPart, column: null };
      }

      const columnName = chain[1];
      if (typeof columnName !== "string") {
        return { outputName: null, column: null };
      }

      const columnSchema = tableSchema.columns[columnName];
      return {
        outputName: columnName,
        column: columnSchema || null,
      };
    }

    // Case 2: Unqualified reference like just "column"
    const columnName = firstPart;
    for (const tableSchema of this.tableContexts.values()) {
      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema) {
        return {
          outputName: columnName,
          column: columnSchema,
        };
      }
    }

    // Column not found in any table context
    return {
      outputName: columnName,
      column: null,
    };
  }

  // ============================================================
  // Type Inference for Computed Expressions
  // ============================================================

  /**
   * Infer the ClickHouse type for a function call expression
   */
  private inferCallType(call: Call): ClickHouseType {
    const name = call.name.toLowerCase();

    // Count functions always return UInt64
    if (name === "count" || name === "countif" || name === "countdistinct" || name === "countdistinctif") {
      return "UInt64";
    }

    // Uniq functions return UInt64
    if (name.startsWith("uniq")) {
      return "UInt64";
    }

    // Sum returns Int64 by default (could be more specific based on input)
    if (name === "sum" || name === "sumif") {
      return "Int64";
    }

    // Avg returns Float64
    if (name === "avg" || name === "avgif") {
      return "Float64";
    }

    // Min/Max preserve the input type - try to infer from first arg
    if (name === "min" || name === "max" || name === "minif" || name === "maxif") {
      if (call.args.length > 0) {
        const argType = this.inferExpressionType(call.args[0]);
        if (argType) return argType;
      }
      return "Float64"; // Default
    }

    // dateDiff returns Int64 (signed difference)
    if (name === "datediff" || name === "date_diff") {
      return "Int64";
    }

    // String functions
    if (
      name === "concat" ||
      name === "substring" ||
      name === "substr" ||
      name === "lower" ||
      name === "upper" ||
      name === "trim" ||
      name === "replace" ||
      name === "tostring"
    ) {
      return "String";
    }

    // Date/DateTime conversion functions
    if (name === "todate" || name === "todate32") {
      return "Date";
    }
    if (name === "todatetime") {
      return "DateTime";
    }
    if (name === "todatetime64") {
      return "DateTime64";
    }

    // Date extraction functions return UInt8/UInt16
    if (
      name === "toyear" ||
      name === "tomonth" ||
      name === "todayofmonth" ||
      name === "todayofweek" ||
      name === "todayofyear" ||
      name === "tohour" ||
      name === "tominute" ||
      name === "tosecond"
    ) {
      return "UInt16";
    }

    // toUnixTimestamp returns UInt32
    if (name === "tounixtimestamp") {
      return "UInt32";
    }

    // Numeric conversion functions
    if (name === "toint8") return "Int8";
    if (name === "toint16") return "Int16";
    if (name === "toint32") return "Int32";
    if (name === "toint64") return "Int64";
    if (name === "touint8") return "UInt8";
    if (name === "touint16") return "UInt16";
    if (name === "touint32") return "UInt32";
    if (name === "touint64") return "UInt64";
    if (name === "tofloat32") return "Float32";
    if (name === "tofloat64") return "Float64";

    // Boolean functions
    if (
      name === "empty" ||
      name === "notempty" ||
      name === "isnull" ||
      name === "isnotnull" ||
      name === "in" ||
      name === "notin"
    ) {
      return "UInt8"; // ClickHouse uses UInt8 for booleans
    }

    // If/multiIf - try to infer from result expressions
    if (name === "if" && call.args.length >= 2) {
      const thenType = this.inferExpressionType(call.args[1]);
      if (thenType) return thenType;
    }

    // Array functions that return arrays
    if (name === "grouparray" || name === "groupuniqarray" || name === "array") {
      return "Array(String)"; // Simplified - could be more specific
    }

    // Length functions return UInt64
    if (name === "length" || name === "lengthutf8" || name === "char_length") {
      return "UInt64";
    }

    // Default to String for unknown functions
    return "String";
  }

  /**
   * Infer the ClickHouse type for an arithmetic operation
   */
  private inferArithmeticType(arith: ArithmeticOperation): ClickHouseType {
    const leftType = this.inferExpressionType(arith.left);
    const rightType = this.inferExpressionType(arith.right);

    // DateTime minus DateTime could produce an interval/Int64
    if (this.isDateTimeType(leftType) && this.isDateTimeType(rightType)) {
      return "Int64"; // Seconds difference
    }

    // If either is Float, result is Float
    if (this.isFloatType(leftType) || this.isFloatType(rightType)) {
      return "Float64";
    }

    // Division always produces Float64
    if (arith.op === ArithmeticOperationOp.Div) {
      return "Float64";
    }

    // Integer arithmetic stays integer
    if (this.isIntType(leftType) && this.isIntType(rightType)) {
      // Return the wider type
      return this.widerIntType(leftType, rightType);
    }

    // Default to Float64 for mixed or unknown types
    return "Float64";
  }

  /**
   * Infer the ClickHouse type for a constant value
   */
  private inferConstantType(constant: Constant): ClickHouseType {
    const value = constant.value;

    if (value === null) {
      return "Nullable(String)";
    }
    if (typeof value === "boolean") {
      return "UInt8";
    }
    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        return "Int64";
      }
      return "Float64";
    }
    if (typeof value === "string") {
      // Check if it looks like a date/datetime
      if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
        return "DateTime64";
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return "Date";
      }
      return "String";
    }

    return "String";
  }

  /**
   * Infer the ClickHouse type for any expression
   */
  private inferExpressionType(expr: Expression): ClickHouseType | null {
    if ((expr as Field).expression_type === "field") {
      const field = expr as Field;
      const { column } = this.resolveFieldToColumn(field.chain);
      return column?.type ?? null;
    }

    if ((expr as Call).expression_type === "call") {
      return this.inferCallType(expr as Call);
    }

    if ((expr as ArithmeticOperation).expression_type === "arithmetic_operation") {
      return this.inferArithmeticType(expr as ArithmeticOperation);
    }

    if ((expr as Constant).expression_type === "constant") {
      return this.inferConstantType(expr as Constant);
    }

    return null;
  }

  /**
   * Check if a type is a DateTime type
   */
  private isDateTimeType(type: ClickHouseType | null): boolean {
    if (!type) return false;
    return (
      type === "DateTime" ||
      type === "DateTime64" ||
      type === "Date" ||
      type === "Date32" ||
      type.startsWith("Nullable(DateTime") ||
      type.startsWith("Nullable(Date")
    );
  }

  /**
   * Check if a type is a Float type
   */
  private isFloatType(type: ClickHouseType | null): boolean {
    if (!type) return false;
    return (
      type === "Float32" ||
      type === "Float64" ||
      type === "Nullable(Float32)" ||
      type === "Nullable(Float64)"
    );
  }

  /**
   * Check if a type is an integer type
   */
  private isIntType(type: ClickHouseType | null): boolean {
    if (!type) return false;
    return (
      type.startsWith("Int") ||
      type.startsWith("UInt") ||
      type.startsWith("Nullable(Int") ||
      type.startsWith("Nullable(UInt")
    );
  }

  /**
   * Return the wider of two integer types
   */
  private widerIntType(left: ClickHouseType | null, right: ClickHouseType | null): ClickHouseType {
    // Simple heuristic: prefer Int64 for safety
    if (left === "Int64" || right === "Int64") return "Int64";
    if (left === "UInt64" || right === "UInt64") return "UInt64";
    if (left === "Int32" || right === "Int32") return "Int32";
    if (left === "UInt32" || right === "UInt32") return "UInt32";
    return "Int64";
  }

  /**
   * Get the virtual column name if a field chain references a virtual column
   * @returns The column name (as exposed in TSQL), or null if not a virtual column
   */
  private getVirtualColumnNameForField(chain: Array<string | number>): string | null {
    if (chain.length === 0) return null;

    const firstPart = chain[0];
    if (typeof firstPart !== "string") return null;

    // Case 1: Qualified reference like table.column
    if (chain.length >= 2) {
      const tableAlias = firstPart;
      const tableSchema = this.tableContexts.get(tableAlias);
      if (!tableSchema) return null;

      const columnName = chain[1];
      if (typeof columnName !== "string") return null;

      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema && isVirtualColumn(columnSchema)) {
        return columnName;
      }
      return null;
    }

    // Case 2: Unqualified reference like just "column"
    const columnName = firstPart;
    for (const tableSchema of this.tableContexts.values()) {
      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema && isVirtualColumn(columnSchema)) {
        return columnName;
      }
    }

    return null;
  }

  // ============================================================
  // JOIN Expression Visitor
  // ============================================================

  private visitJoinExpr(node: JoinExpr): JoinExprResponse {
    let extraWhere: Expression | null = null;
    const joinStrings: string[] = [];

    // Add join type
    if (node.join_type) {
      joinStrings.push(node.join_type);
    }

    // Handle table reference
    if (node.table) {
      const tableExpr = node.table;

      if ((tableExpr as Field).expression_type === "field") {
        // Direct table reference
        const field = tableExpr as Field;
        const tableName = field.chain[0];
        if (typeof tableName !== "string") {
          throw new QueryError("Table name must be a string");
        }

        // Look up table schema and get ClickHouse table name
        const tableSchema = this.lookupTable(tableName);
        joinStrings.push(tableSchema.clickhouseName);

        // Register this table context for column name resolution
        // Use the alias if provided, otherwise use the TSQL table name
        const contextKey = node.alias || tableName;
        this.tableContexts.set(contextKey, tableSchema);

        // Add tenant isolation guard
        extraWhere = this.createTenantGuard(tableSchema, node.alias || tableName);
      } else if (
        (tableExpr as SelectQuery).expression_type === "select_query" ||
        (tableExpr as SelectSetQuery).expression_type === "select_set_query"
      ) {
        // Subquery
        joinStrings.push(this.visit(tableExpr));
      } else if ((tableExpr as Placeholder).expression_type === "placeholder") {
        // Placeholder - visit inner expression
        joinStrings.push(this.visit(tableExpr));
      } else {
        throw new QueryError(
          `Unsupported table expression type: ${(tableExpr as Expression).expression_type}`
        );
      }
    }

    // Add alias
    if (node.alias) {
      joinStrings.push(`AS ${this.printIdentifier(node.alias)}`);
    }

    // Add FINAL
    if (node.table_final) {
      joinStrings.push("FINAL");
    }

    // Add SAMPLE
    if (node.sample) {
      const sampleClause = this.visitSampleExpr(node.sample);
      if (sampleClause) {
        joinStrings.push(sampleClause);
      }
    }

    // Add constraint
    if (node.constraint) {
      joinStrings.push(`${node.constraint.constraint_type} ${this.visit(node.constraint)}`);
    }

    return {
      printedSql: joinStrings.join(" "),
      where: extraWhere,
    };
  }

  // ============================================================
  // Tenant Isolation
  // ============================================================

  /**
   * Create a WHERE clause expression for tenant isolation
   * Note: We use just the column name without table prefix since ClickHouse
   * requires the actual table name (task_runs_v2), not the TSQL alias (task_runs)
   *
   * Organization ID is always required. Project ID and Environment ID are optional -
   * if not provided, the query will return results across all projects/environments.
   */
  private createTenantGuard(tableSchema: TableSchema, _tableAlias: string): And | CompareOperation {
    const { tenantColumns } = tableSchema;

    // Organization guard is always required
    const orgGuard: CompareOperation = {
      expression_type: "compare_operation",
      op: CompareOperationOp.Eq,
      left: { expression_type: "field", chain: [tenantColumns.organizationId] } as Field,
      right: { expression_type: "constant", value: this.context.organizationId } as Constant,
    };

    // Collect all guards - org is always included
    const guards: CompareOperation[] = [orgGuard];

    // Only add project guard if projectId is provided
    if (this.context.projectId !== undefined) {
      const projectGuard: CompareOperation = {
        expression_type: "compare_operation",
        op: CompareOperationOp.Eq,
        left: { expression_type: "field", chain: [tenantColumns.projectId] } as Field,
        right: { expression_type: "constant", value: this.context.projectId } as Constant,
      };
      guards.push(projectGuard);
    }

    // Only add environment guard if environmentId is provided
    if (this.context.environmentId !== undefined) {
      const envGuard: CompareOperation = {
        expression_type: "compare_operation",
        op: CompareOperationOp.Eq,
        left: { expression_type: "field", chain: [tenantColumns.environmentId] } as Field,
        right: { expression_type: "constant", value: this.context.environmentId } as Constant,
      };
      guards.push(envGuard);
    }

    // If only org guard, return it directly (no need for AND wrapper)
    if (guards.length === 1) {
      return orgGuard;
    }

    return {
      expression_type: "and",
      exprs: guards,
    };
  }

  // ============================================================
  // Expression Visitors
  // ============================================================

  private visitCTE(node: CTE): string {
    return this.visit(node.expr);
  }

  private visitAlias(node: Alias): string {
    const expr = this.visit(node.expr);
    if (node.hidden) {
      return expr;
    }
    return `${expr} AS ${this.printIdentifier(node.alias)}`;
  }

  private visitArithmeticOperation(node: ArithmeticOperation): string {
    const left = this.visit(node.left);
    const right = this.visit(node.right);

    switch (node.op) {
      case ArithmeticOperationOp.Add:
        return `plus(${left}, ${right})`;
      case ArithmeticOperationOp.Sub:
        return `minus(${left}, ${right})`;
      case ArithmeticOperationOp.Mult:
        return `multiply(${left}, ${right})`;
      case ArithmeticOperationOp.Div:
        return `divide(${left}, ${right})`;
      case ArithmeticOperationOp.Mod:
        return `modulo(${left}, ${right})`;
      default:
        throw new ImpossibleASTError(`Unknown ArithmeticOperationOp: ${node.op}`);
    }
  }

  private visitAnd(node: And): string {
    if (node.exprs.length === 1) {
      return this.visit(node.exprs[0]);
    }

    // Optimization: filter out constant true values, short-circuit on false
    const exprs: string[] = [];
    for (const expr of node.exprs) {
      const printed = this.visit(expr);
      if (printed === "0") {
        // Short-circuit: and(..., 0, ...) => 0
        return "0";
      }
      if (printed !== "1") {
        // Skip constant true values
        exprs.push(printed);
      }
    }

    if (exprs.length === 0) {
      return "1";
    }
    if (exprs.length === 1) {
      return exprs[0];
    }
    return `and(${exprs.join(", ")})`;
  }

  private visitOr(node: Or): string {
    if (node.exprs.length === 1) {
      return this.visit(node.exprs[0]);
    }

    // Optimization: filter out constant false values, short-circuit on true
    const exprs: string[] = [];
    for (const expr of node.exprs) {
      const printed = this.visit(expr);
      if (printed === "1") {
        // Short-circuit: or(..., 1, ...) => 1
        return "1";
      }
      if (printed !== "0") {
        // Skip constant false values
        exprs.push(printed);
      }
    }

    if (exprs.length === 0) {
      return "0";
    }
    if (exprs.length === 1) {
      return exprs[0];
    }
    return `or(${exprs.join(", ")})`;
  }

  private visitNot(node: Not): string {
    return `not(${this.visit(node.expr)})`;
  }

  private visitCompareOperation(node: CompareOperation): string {
    // Check if we need to transform values using valueMap
    const columnSchema = this.extractColumnSchemaFromExpression(node.left);

    // Transform the right side if it contains user-friendly values
    const transformedRight = this.transformValueMapExpression(node.right, columnSchema);

    const left = this.visit(node.left);
    const right = this.visit(transformedRight);

    switch (node.op) {
      case CompareOperationOp.Eq:
        // Handle NULL comparison
        if (
          (transformedRight as Constant).expression_type === "constant" &&
          (transformedRight as Constant).value === null
        ) {
          return `isNull(${left})`;
        }
        if (
          (node.left as Constant).expression_type === "constant" &&
          (node.left as Constant).value === null
        ) {
          return `isNull(${right})`;
        }
        return `equals(${left}, ${right})`;

      case CompareOperationOp.NotEq:
        // Handle NULL comparison
        if (
          (transformedRight as Constant).expression_type === "constant" &&
          (transformedRight as Constant).value === null
        ) {
          return `isNotNull(${left})`;
        }
        if (
          (node.left as Constant).expression_type === "constant" &&
          (node.left as Constant).value === null
        ) {
          return `isNotNull(${right})`;
        }
        return `notEquals(${left}, ${right})`;

      case CompareOperationOp.Lt:
        return `less(${left}, ${right})`;
      case CompareOperationOp.LtEq:
        return `lessOrEquals(${left}, ${right})`;
      case CompareOperationOp.Gt:
        return `greater(${left}, ${right})`;
      case CompareOperationOp.GtEq:
        return `greaterOrEquals(${left}, ${right})`;
      case CompareOperationOp.Like:
        return `like(${left}, ${right})`;
      case CompareOperationOp.ILike:
        return `ilike(${left}, ${right})`;
      case CompareOperationOp.NotLike:
        return `notLike(${left}, ${right})`;
      case CompareOperationOp.NotILike:
        return `notILike(${left}, ${right})`;
      case CompareOperationOp.In:
        return `in(${left}, ${right})`;
      case CompareOperationOp.NotIn:
        return `notIn(${left}, ${right})`;
      case CompareOperationOp.GlobalIn:
        return `globalIn(${left}, ${right})`;
      case CompareOperationOp.GlobalNotIn:
        return `globalNotIn(${left}, ${right})`;
      case CompareOperationOp.Regex:
        return `match(${left}, ${right})`;
      case CompareOperationOp.NotRegex:
        return `not(match(${left}, ${right}))`;
      case CompareOperationOp.IRegex:
        return `match(${left}, concat('(?i)', ${right}))`;
      case CompareOperationOp.NotIRegex:
        return `not(match(${left}, concat('(?i)', ${right})))`;
      default:
        throw new ImpossibleASTError(`Unknown CompareOperationOp: ${node.op}`);
    }
  }

  /**
   * Extract column schema from a field expression if it references a known column
   */
  private extractColumnSchemaFromExpression(expr: Expression): ColumnSchema | null {
    if ((expr as Field).expression_type !== "field") return null;

    const field = expr as Field;
    const chain = field.chain;

    if (chain.length === 0) return null;

    const firstPart = chain[0];
    if (typeof firstPart !== "string") return null;

    // Qualified reference: table.column
    if (chain.length >= 2) {
      const tableAlias = firstPart;
      const tableSchema = this.tableContexts.get(tableAlias);
      if (!tableSchema) return null;

      const columnName = chain[1];
      if (typeof columnName !== "string") return null;

      return tableSchema.columns[columnName] || null;
    }

    // Unqualified reference
    const columnName = firstPart;
    for (const tableSchema of this.tableContexts.values()) {
      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema) {
        return columnSchema;
      }
    }

    return null;
  }

  /**
   * Transform an expression's values using the column's valueMap if applicable
   * Returns the original expression if no transformation is needed
   */
  private transformValueMapExpression(
    expr: Expression,
    columnSchema: ColumnSchema | null
  ): Expression {
    // No column schema or no valueMap, return as-is
    if (!columnSchema || !columnSchema.valueMap) {
      return expr;
    }

    // Handle constant string values
    if ((expr as Constant).expression_type === "constant") {
      const constant = expr as Constant;
      if (typeof constant.value === "string") {
        const internalValue = getInternalValue(columnSchema, constant.value);
        if (internalValue !== constant.value) {
          // Return a new constant with the transformed value
          return {
            expression_type: "constant",
            value: internalValue,
          } as Constant;
        }
      }
      return expr;
    }

    // Handle arrays (for IN expressions with [...])
    if ((expr as ASTArray).expression_type === "array") {
      const array = expr as ASTArray;
      const transformedExprs = array.exprs.map((e) =>
        this.transformValueMapExpression(e, columnSchema)
      );

      // Check if any expressions were actually transformed
      const hasChanges = transformedExprs.some((e, i) => e !== array.exprs[i]);
      if (hasChanges) {
        return {
          expression_type: "array",
          exprs: transformedExprs,
        } as ASTArray;
      }
      return expr;
    }

    // Handle tuples (for IN expressions with (...))
    if ((expr as Tuple).expression_type === "tuple") {
      const tuple = expr as Tuple;
      const transformedExprs = tuple.exprs.map((e) =>
        this.transformValueMapExpression(e, columnSchema)
      );

      // Check if any expressions were actually transformed
      const hasChanges = transformedExprs.some((e, i) => e !== tuple.exprs[i]);
      if (hasChanges) {
        return {
          expression_type: "tuple",
          exprs: transformedExprs,
        } as Tuple;
      }
      return expr;
    }

    // Other expression types, return as-is
    return expr;
  }

  private visitBetweenExpr(node: BetweenExpr): string {
    const expr = this.visit(node.expr);
    const low = this.visit(node.low);
    const high = this.visit(node.high);
    const notKw = node.negated ? " NOT" : "";
    return `${expr}${notKw} BETWEEN ${low} AND ${high}`;
  }

  private visitOrderExpr(node: OrderExpr): string {
    const expr = this.visit(node.expr);
    return `${expr} ${node.order || "ASC"}`;
  }

  private visitArrayAccess(node: ArrayAccess): string {
    const array = this.visit(node.array);
    const property = this.visit(node.property);
    return `${array}[${property}]`;
  }

  private visitArray(node: ASTArray): string {
    const elements = node.exprs.map((e) => this.visit(e));
    return `[${elements.join(", ")}]`;
  }

  private visitDict(node: Dict): string {
    // Convert dict to tuple format for ClickHouse
    let str = "tuple('__hx_tag', '__hx_obj'";
    for (const [key, value] of node.items) {
      str += `, ${this.visit(key)}, ${this.visit(value)}`;
    }
    return str + ")";
  }

  private visitTupleAccess(node: TupleAccess): string {
    const tuple = this.visit(node.tuple);
    const index = node.index;
    const isSimple =
      (node.tuple as Field).expression_type === "field" ||
      (node.tuple as Tuple).expression_type === "tuple" ||
      (node.tuple as Call).expression_type === "call";
    return isSimple ? `${tuple}.${index}` : `(${tuple}).${index}`;
  }

  private visitTuple(node: Tuple): string {
    const elements = node.exprs.map((e) => this.visit(e));
    return `tuple(${elements.join(", ")})`;
  }

  private visitLambda(node: Lambda): string {
    const identifiers = node.args.map((arg) => this.printIdentifier(arg));
    if (identifiers.length === 0) {
      throw new QueryError("Lambdas require at least one argument");
    }
    const args = identifiers.length === 1 ? identifiers[0] : `(${identifiers.join(", ")})`;
    return `${args} -> ${this.visit(node.expr as Expression)}`;
  }

  private visitConstant(node: Constant): string {
    const value = node.value;

    // Inline simple constants
    if (value === null) {
      return "NULL";
    }
    if (typeof value === "boolean") {
      return value ? "1" : "0";
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        if (Number.isNaN(value)) return "nan";
        return value > 0 ? "inf" : "-inf";
      }
      return String(value);
    }

    // Use parameterized query for strings and other types
    return this.context.addValue(value);
  }

  private visitField(node: Field): string {
    if (node.chain.length === 0) {
      throw new ImpossibleASTError("Field chain is empty");
    }

    // Handle asterisk
    if (node.chain.length === 1 && node.chain[0] === "*") {
      return "*";
    }

    // Handle table.* asterisk
    if (node.chain.length === 2 && node.chain[1] === "*") {
      const tableAlias = node.chain[0];
      if (typeof tableAlias === "string") {
        return `${this.printIdentifier(tableAlias)}.*`;
      }
    }

    // Check if this field is a virtual column
    const virtualExpression = this.getVirtualColumnExpressionForField(node.chain);
    if (virtualExpression !== null) {
      // Return the expression wrapped in parentheses
      return `(${virtualExpression})`;
    }

    // Try to resolve column names through table context
    const resolvedChain = this.resolveFieldChain(node.chain);

    // Print each chain element
    return resolvedChain.map((part) => this.printIdentifierOrIndex(part)).join(".");
  }

  /**
   * Check if a field chain references a virtual column and return its expression
   * @returns The virtual column expression, or null if not a virtual column
   */
  private getVirtualColumnExpressionForField(chain: Array<string | number>): string | null {
    if (chain.length === 0) return null;

    const firstPart = chain[0];
    if (typeof firstPart !== "string") return null;

    // Case 1: Qualified reference like table.column
    if (chain.length >= 2) {
      const tableAlias = firstPart;
      const tableSchema = this.tableContexts.get(tableAlias);
      if (!tableSchema) return null;

      const columnName = chain[1];
      if (typeof columnName !== "string") return null;

      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema && isVirtualColumn(columnSchema)) {
        return columnSchema.expression!;
      }
      return null;
    }

    // Case 2: Unqualified reference like just "column"
    const columnName = firstPart;
    for (const tableSchema of this.tableContexts.values()) {
      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema && isVirtualColumn(columnSchema)) {
        return columnSchema.expression!;
      }
    }

    return null;
  }

  /**
   * Resolve field chain to use ClickHouse column names where applicable
   * Handles both qualified (table.column) and unqualified (column) references
   */
  private resolveFieldChain(chain: Array<string | number>): Array<string | number> {
    if (chain.length === 0) {
      return chain;
    }

    const firstPart = chain[0];
    if (typeof firstPart !== "string") {
      return chain; // Index access, return as-is
    }

    // Case 1: Qualified reference like table.column or table.column.nested
    if (chain.length >= 2) {
      const tableAlias = firstPart;
      const tableSchema = this.tableContexts.get(tableAlias);

      if (tableSchema) {
        // This is a table.column reference
        const columnName = chain[1];
        if (typeof columnName === "string") {
          const resolvedColumn = this.resolveColumnName(tableSchema, columnName);
          return [tableAlias, resolvedColumn, ...chain.slice(2)];
        }
      }
      // Not a known table alias, might be a nested field - return as-is
      return chain;
    }

    // Case 2: Unqualified reference like just "column"
    // Try to find the column in any table context
    const columnName = firstPart;
    for (const tableSchema of this.tableContexts.values()) {
      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema) {
        return [columnSchema.clickhouseName || columnSchema.name, ...chain.slice(1)];
      }
    }

    // Column not found in any table context - return as-is (might be a function, subquery alias, etc.)
    return chain;
  }

  /**
   * Resolve a column name to its ClickHouse name using the table schema
   */
  private resolveColumnName(tableSchema: TableSchema, columnName: string): string {
    const columnSchema = tableSchema.columns[columnName];
    if (columnSchema) {
      return columnSchema.clickhouseName || columnSchema.name;
    }
    // Column not in schema - return as-is (might be a computed column, etc.)
    return columnName;
  }

  private visitPlaceholder(node: Placeholder): string {
    return this.visit(node.expr);
  }

  private visitCall(node: Call): string {
    const name = node.name;

    // Check if this is a comparison function
    if (name in TSQL_COMPARISON_MAPPING) {
      const op = TSQL_COMPARISON_MAPPING[name];
      if (node.args.length !== 2) {
        throw new QueryError(`Comparison '${name}' requires exactly two arguments`);
      }
      return this.visitCompareOperation({
        expression_type: "compare_operation",
        left: node.args[0],
        right: node.args[1],
        op,
      });
    }

    // Check for aggregation function
    const aggMeta = findTSQLAggregation(name);
    if (aggMeta) {
      validateFunctionArgs(node.args, aggMeta.minArgs, aggMeta.maxArgs, name, {
        functionTerm: "aggregation",
      });

      // Check for nested aggregations
      for (const stackNode of this.stack.slice().reverse()) {
        if ((stackNode as SelectQuery).expression_type === "select_query") {
          break;
        }
        if ((stackNode as Call).expression_type === "call" && stackNode !== node) {
          const stackCall = stackNode as Call;
          if (findTSQLAggregation(stackCall.name)) {
            throw new QueryError(
              `Aggregation '${name}' cannot be nested inside another aggregation '${stackCall.name}'`
            );
          }
        }
      }

      const args = node.args.map((arg) => this.visit(arg));
      const params = node.params ? node.params.map((p) => this.visit(p)) : null;
      const paramsPart = params ? `(${params.join(", ")})` : "";
      const distinctPart = node.distinct ? "DISTINCT " : "";
      return `${aggMeta.clickhouseName}${paramsPart}(${distinctPart}${args.join(", ")})`;
    }

    // Check for regular function
    const funcMeta = findTSQLFunction(name);
    if (funcMeta) {
      validateFunctionArgs(node.args, funcMeta.minArgs, funcMeta.maxArgs, name);

      const args = node.args.map((arg) => this.visit(arg));
      const params = node.params ? node.params.map((p) => this.visit(p)) : null;
      const paramsPart = params ? `(${params.join(", ")})` : "";
      return `${funcMeta.clickhouseName}${paramsPart}(${args.join(", ")})`;
    }

    // Unknown function - throw error
    throw new QueryError(`Unknown function: ${name}`);
  }

  private visitJoinConstraint(node: JoinConstraint): string {
    return this.visit(node.expr);
  }

  private visitWindowFrameExpr(node: WindowFrameExpr): string {
    if (node.frame_type === "CURRENT ROW") {
      return "CURRENT ROW";
    }
    if (node.frame_value !== undefined) {
      return `${node.frame_value} ${node.frame_type}`;
    }
    return `UNBOUNDED ${node.frame_type}`;
  }

  private visitWindowExpr(node: WindowExpr): string {
    const parts: string[] = [];

    if (node.partition_by && node.partition_by.length > 0) {
      parts.push(`PARTITION BY ${node.partition_by.map((e) => this.visit(e)).join(", ")}`);
    }

    if (node.order_by && node.order_by.length > 0) {
      parts.push(`ORDER BY ${node.order_by.map((e) => this.visit(e)).join(", ")}`);
    }

    if (node.frame_method && node.frame_start) {
      let frameStr = `${node.frame_method} `;
      if (node.frame_end) {
        frameStr += `BETWEEN ${this.visit(node.frame_start)} AND ${this.visit(node.frame_end)}`;
      } else {
        frameStr += this.visit(node.frame_start);
      }
      parts.push(frameStr);
    }

    return parts.join(" ");
  }

  private visitWindowFunction(node: WindowFunction): string {
    const args = node.args ? node.args.map((a) => this.visit(a)) : [];
    const funcCall = `${node.name}(${args.join(", ")})`;

    if (node.over_identifier) {
      return `${funcCall} OVER ${this.printIdentifier(node.over_identifier)}`;
    }
    if (node.over_expr) {
      return `${funcCall} OVER (${this.visit(node.over_expr)})`;
    }
    return funcCall;
  }

  private visitLimitByExpr(node: LimitByExpr): string {
    const exprs = node.exprs.map((e) => this.visit(e)).join(", ");
    const offsetPart = node.offset_value ? ` OFFSET ${this.visit(node.offset_value)}` : "";
    return `LIMIT ${this.visit(node.n)}${offsetPart} BY ${exprs}`;
  }

  private visitRatioExpr(node: RatioExpr): string {
    const left = this.visit(node.left);
    if (node.right) {
      return `${left}/${this.visit(node.right)}`;
    }
    return left;
  }

  private visitSampleExpr(node: SampleExpr): string {
    const sample = this.visitRatioExpr(node.sample_value);
    if (node.offset_value) {
      return `SAMPLE ${sample} OFFSET ${this.visitRatioExpr(node.offset_value)}`;
    }
    return `SAMPLE ${sample}`;
  }

  // ============================================================
  // Helper Methods
  // ============================================================

  /**
   * Print an identifier safely escaped for ClickHouse
   */
  private printIdentifier(name: string): string {
    return escapeClickHouseIdentifier(name);
  }

  /**
   * Print an identifier or array index
   */
  private printIdentifierOrIndex(part: string | number): string {
    if (typeof part === "number") {
      return String(part);
    }
    return escapeClickHouseIdentifier(part);
  }

  /**
   * Check if a node is a SelectSetQuery
   */
  private isSelectSetQuery(node: AST): boolean {
    return (node as SelectSetQuery).expression_type === "select_set_query";
  }

  /**
   * Look up a table in the schema registry
   */
  private lookupTable(tableName: string): TableSchema {
    return validateTable(this.context.schema, tableName);
  }
}

// ============================================================
// Public API
// ============================================================

/**
 * Print a TSQL AST to ClickHouse SQL
 */
export function printToClickHouse(
  node: SelectQuery | SelectSetQuery,
  context: PrinterContext,
  options: { pretty?: boolean } = {}
): PrintResult {
  const printer = new ClickHousePrinter(context, options);
  return printer.print(node);
}
