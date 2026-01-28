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
import { PrinterContext, WhereClauseCondition } from "./printer_context";
import {
  findTable,
  validateTable,
  TableSchema,
  ColumnSchema,
  getInternalValue,
  isVirtualColumn,
  OutputColumnMetadata,
  ClickHouseType,
  hasFieldMapping,
  getInternalValueFromMappingCaseInsensitive,
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
  /**
   * Columns that were hidden when SELECT * was used.
   * Only populated when SELECT * is transformed to core columns only.
   */
  hiddenColumns?: string[];
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
  /** Whether we're currently processing GROUP BY expressions */
  private inGroupByContext = false;
  /** Whether the current query has a GROUP BY clause (used for JSON subfield type hints) */
  private queryHasGroupBy = false;
  /** Columns hidden when SELECT * is expanded to core columns only */
  private hiddenColumns: string[] = [];
  /**
   * Set of column aliases defined in the current SELECT clause.
   * Used to allow ORDER BY/HAVING to reference aliased columns.
   */
  private selectAliases: Set<string> = new Set();
  /**
   * Set of internal ClickHouse column names that are allowed (e.g., tenant columns).
   * These are populated from tableSchema.tenantColumns when processing joins.
   */
  private allowedInternalColumns: Set<string> = new Set();
  /**
   * Set of internal-only column names that are NOT user-queryable.
   * These are tenant columns and required filter columns that are not exposed in tableSchema.columns.
   * Used to block user queries from accessing internal columns in SELECT, ORDER BY, GROUP BY, HAVING.
   */
  private internalOnlyColumns: Set<string> = new Set();
  /**
   * Whether we're currently processing user projection clauses (SELECT, ORDER BY, GROUP BY, HAVING).
   * When true, internal-only columns will be rejected.
   */
  private inProjectionContext = false;

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
    this.hiddenColumns = [];
    const sql = this.visit(node);
    const result: PrintResult = {
      sql,
      params: this.context.getParams(),
      columns: this.outputColumns,
    };
    if (this.hiddenColumns.length > 0) {
      result.hiddenColumns = this.hiddenColumns;
    }
    return result;
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
        throw new NotImplementedError(
          `Unknown expression type: ${nodeType}. Node: ${JSON.stringify(node, null, 2).slice(
            0,
            200
          )}`
        );
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

    // Save and clear table contexts
    // Top-level queries clear contexts; subqueries save parent context and create fresh context
    const savedTableContexts = new Map(this.tableContexts);
    const savedInternalColumns = new Set(this.allowedInternalColumns);
    const savedInternalOnlyColumns = new Set(this.internalOnlyColumns);
    if (isTopLevelQuery) {
      this.tableContexts.clear();
      this.allowedInternalColumns.clear();
      this.internalOnlyColumns.clear();
    } else {
      // Subqueries get fresh contexts - they don't inherit parent tables
      // (the parent will restore its context after the subquery is processed)
      this.tableContexts = new Map();
      this.allowedInternalColumns = new Set();
      this.internalOnlyColumns = new Set();
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

    // Extract SELECT column aliases BEFORE visiting columns
    // This allows ORDER BY/HAVING to reference aliased columns
    const savedAliases = this.selectAliases;
    this.selectAliases = new Set();
    if (node.select) {
      for (const col of node.select) {
        this.extractSelectAlias(col);
      }
    }

    // Track if query has GROUP BY for JSON subfield type hint decisions
    // (ClickHouse requires .:String for Dynamic types in GROUP BY, and SELECT must match)
    const savedQueryHasGroupBy = this.queryHasGroupBy;
    this.queryHasGroupBy = !!node.group_by;

    // Process SELECT columns and collect metadata
    // Using flatMap because asterisk expansion can return multiple columns
    // Set inProjectionContext to block internal-only columns in user projections
    let columns: string[];
    if (node.select && node.select.length > 0) {
      // Only collect metadata for top-level queries (not subqueries)
      if (isTopLevelQuery) {
        this.outputColumns = [];
      }
      this.inProjectionContext = true;
      columns = node.select.flatMap((col) =>
        this.visitSelectColumnWithMetadata(col, isTopLevelQuery)
      );
      this.inProjectionContext = false;
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

    // Process GROUP BY with context flags:
    // - inGroupByContext: use raw columns for whereTransform columns
    // - inProjectionContext: block internal-only columns
    let groupBy: string[] | null = null;
    if (node.group_by) {
      this.inGroupByContext = true;
      this.inProjectionContext = true;
      groupBy = node.group_by.map((col) => this.visit(col));
      this.inProjectionContext = false;
      this.inGroupByContext = false;
    }

    // Process HAVING with inProjectionContext to block internal-only columns
    let having: string | null = null;
    if (node.having) {
      this.inProjectionContext = true;
      having = this.visit(node.having);
      this.inProjectionContext = false;
    }

    // Process ORDER BY with inProjectionContext to block internal-only columns
    let orderBy: string[] | null = null;
    if (node.order_by) {
      this.inProjectionContext = true;
      orderBy = node.order_by.map((col) => this.visit(col));
      this.inProjectionContext = false;
    }

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

    // Restore saved contexts (for nested queries)
    this.selectAliases = savedAliases;
    this.queryHasGroupBy = savedQueryHasGroupBy;
    this.tableContexts = savedTableContexts;
    this.allowedInternalColumns = savedInternalColumns;
    this.internalOnlyColumns = savedInternalOnlyColumns;

    return response;
  }

  /**
   * Extract column aliases from a SELECT expression.
   * Handles explicit aliases (AS name) and implicit names from aggregations/functions.
   *
   * NOTE: We intentionally do NOT add field names as aliases here.
   * Field names (e.g., SELECT status) are columns from the table, not aliases.
   * Only explicit aliases (SELECT x AS name) and implicit function names
   * (SELECT COUNT() → 'count') should be added.
   */
  private extractSelectAlias(expr: Expression): void {
    // Handle explicit Alias: SELECT ... AS name
    if ((expr as Alias).expression_type === "alias") {
      this.selectAliases.add((expr as Alias).alias);
      return;
    }

    // Handle implicit names from function calls (e.g., COUNT() → 'count')
    if ((expr as Call).expression_type === "call") {
      const call = expr as Call;
      // Aggregations and functions get implicit lowercase names
      this.selectAliases.add(call.name.toLowerCase());
      return;
    }

    // Handle implicit names from arithmetic operations (e.g., a + b → 'plus')
    if ((expr as ArithmeticOperation).expression_type === "arithmetic_operation") {
      const op = expr as ArithmeticOperation;
      const opNames: Record<ArithmeticOperationOp, string> = {
        [ArithmeticOperationOp.Add]: "plus",
        [ArithmeticOperationOp.Sub]: "minus",
        [ArithmeticOperationOp.Mult]: "multiply",
        [ArithmeticOperationOp.Div]: "divide",
        [ArithmeticOperationOp.Mod]: "modulo",
      };
      this.selectAliases.add(opNames[op.op]);
      return;
    }

    // Field references (e.g., SELECT status) are NOT aliases - they're columns
    // that will be validated against the table schema. Don't add them here.
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
   * - `SELECT *` → Expands to all selectable columns from the table(s)
   *
   * @param col - The column expression
   * @param collectMetadata - Whether to collect column metadata (only for top-level queries)
   * @returns Array of SQL column strings (usually one, but multiple for asterisk expansion)
   */
  private visitSelectColumnWithMetadata(col: Expression, collectMetadata: boolean): string[] {
    // Check for asterisk expansion first
    if ((col as Field).expression_type === "field") {
      const field = col as Field;
      const asteriskExpansion = this.expandAsterisk(field.chain, collectMetadata);
      if (asteriskExpansion !== null) {
        return asteriskExpansion;
      }
    }

    // Extract output name and source column before visiting
    const { outputName, sourceColumn, inferredType } = this.analyzeSelectColumn(col);
    // effectiveOutputName may be overridden for JSON subfields
    let effectiveOutputName = outputName;

    // Check if this is a bare Field (not wrapped in Alias)
    let sqlResult: string;
    if ((col as Field).expression_type === "field") {
      const field = col as Field;

      // Check if this is a bare JSON field that should use a text column
      const textColumn = this.getTextColumnForField(field.chain);
      if (textColumn !== null && outputName) {
        // Use the text column instead of the JSON column, with alias to preserve name
        sqlResult = `${this.printIdentifier(textColumn)} AS ${this.printIdentifier(outputName)}`;
      } else {
        const virtualColumnName = this.getVirtualColumnNameForField(field.chain);

        if (virtualColumnName !== null) {
          // Visit the field (which will return the expression)
          const visited = this.visit(col);
          // Add the alias to preserve the column name
          sqlResult = `${visited} AS ${this.printIdentifier(virtualColumnName)}`;
        } else {
          // Visit the field to get the ClickHouse SQL
          const visited = this.visit(col);

          // Check if this is a JSON subfield access (will have .:String type hint)
          // If so, add an alias to preserve the nice column name (dots → underscores)
          const isJsonSubfield = this.isJsonSubfieldAccess(field.chain);
          if (isJsonSubfield) {
            // Build the alias using underscores, excluding any dataPrefix
            // e.g., output.message -> "output_message" (not "output_data_message")
            const dataPrefix = this.getDataPrefixForField(field.chain);
            const aliasName = this.buildAliasWithoutDataPrefix(field.chain, dataPrefix);
            sqlResult = `${visited} AS ${this.printIdentifier(aliasName)}`;
            // Override output name for metadata
            effectiveOutputName = aliasName;
          }
          // Check if the column has a different clickhouseName - if so, add an alias
          // to ensure results come back with the user-facing name
          else if (
            outputName &&
            sourceColumn?.clickhouseName &&
            sourceColumn.clickhouseName !== outputName
          ) {
            sqlResult = `${visited} AS ${this.printIdentifier(outputName)}`;
          } else {
            sqlResult = visited;
          }
        }
      }
    } else if (
      // Handle expressions that need implicit aliases (Call, ArithmeticOperation, Constant)
      // These expressions get implicit names and need AS clauses so results match metadata
      (col as Alias).expression_type !== "alias" &&
      ((col as Call).expression_type === "call" ||
        (col as ArithmeticOperation).expression_type === "arithmetic_operation" ||
        (col as Constant).expression_type === "constant")
    ) {
      const visited = this.visit(col);
      // Add explicit AS clause with the implicit name so ClickHouse results match our metadata
      if (outputName) {
        sqlResult = `${visited} AS ${this.printIdentifier(outputName)}`;
      } else {
        sqlResult = visited;
      }
    } else if ((col as Alias).expression_type === "alias") {
      // Handle Alias expressions - check if inner expression is a bare JSON field with textColumn
      const alias = col as Alias;
      if ((alias.expr as Field).expression_type === "field") {
        const innerField = alias.expr as Field;
        const textColumn = this.getTextColumnForField(innerField.chain);
        if (textColumn !== null) {
          // Use the text column with the user's explicit alias
          sqlResult = `${this.printIdentifier(textColumn)} AS ${this.printIdentifier(alias.alias)}`;
        } else {
          sqlResult = this.visit(col);
        }
      } else {
        sqlResult = this.visit(col);
      }
    } else {
      // For other types, visit normally
      sqlResult = this.visit(col);
    }

    // Collect metadata for top-level queries
    if (collectMetadata && effectiveOutputName) {
      const metadata: OutputColumnMetadata = {
        name: effectiveOutputName,
        type: sourceColumn?.type ?? inferredType ?? "String",
      };

      // Only add customRenderType if specified in schema
      if (sourceColumn?.customRenderType) {
        metadata.customRenderType = sourceColumn.customRenderType;
      }

      // Only add description if specified in schema (columns and virtual columns)
      if (sourceColumn?.description) {
        metadata.description = sourceColumn.description;
      }

      this.outputColumns.push(metadata);
    }

    return [sqlResult];
  }

  /**
   * Expand an asterisk field to all selectable columns from the table(s)
   *
   * @param chain - The field chain (["*"] for SELECT *, [tableName, "*"] for table.*)
   * @param collectMetadata - Whether to collect column metadata
   * @returns Array of SQL column strings, or null if not an asterisk
   */
  private expandAsterisk(chain: Array<string | number>, collectMetadata: boolean): string[] | null {
    // Check for SELECT * (chain: ["*"])
    if (chain.length === 1 && chain[0] === "*") {
      return this.expandAllTableColumns(collectMetadata);
    }

    // Check for table.* (chain: [tableName, "*"])
    if (chain.length === 2 && chain[1] === "*") {
      const tableAlias = chain[0];
      if (typeof tableAlias === "string") {
        return this.expandTableColumns(tableAlias, collectMetadata);
      }
    }

    return null;
  }

  /**
   * Expand SELECT * to core columns only from all tables in context.
   * Non-core columns are tracked in hiddenColumns for user notification.
   */
  private expandAllTableColumns(collectMetadata: boolean): string[] {
    const results: string[] = [];

    // Iterate through all tables in the context
    for (const [tableAlias, tableSchema] of this.tableContexts.entries()) {
      const tableColumns = this.getSelectableColumnsFromSchema(
        tableSchema,
        tableAlias,
        collectMetadata,
        true // onlyCoreColumns - SELECT * only returns core columns
      );
      results.push(...tableColumns);
    }

    // If no tables in context, fall back to literal *
    if (results.length === 0) {
      return ["*"];
    }

    return results;
  }

  /**
   * Expand table.* to core columns only from a specific table.
   * Non-core columns are tracked in hiddenColumns for user notification.
   */
  private expandTableColumns(tableAlias: string, collectMetadata: boolean): string[] {
    const tableSchema = this.tableContexts.get(tableAlias);

    if (!tableSchema) {
      // Table not found in context, fall back to literal table.*
      return [`${this.printIdentifier(tableAlias)}.*`];
    }

    return this.getSelectableColumnsFromSchema(
      tableSchema,
      tableAlias,
      collectMetadata,
      true // onlyCoreColumns - table.* only returns core columns
    );
  }

  /**
   * Get selectable columns from a table schema as SQL strings
   *
   * @param tableSchema - The table schema
   * @param tableAlias - The alias used for the table in the query (for table-qualified columns)
   * @param collectMetadata - Whether to collect column metadata
   * @param onlyCoreColumns - If true, only return core columns and track hidden columns (but falls back to all columns if no core columns are defined)
   * @returns Array of SQL column strings
   */
  private getSelectableColumnsFromSchema(
    tableSchema: TableSchema,
    tableAlias: string,
    collectMetadata: boolean,
    onlyCoreColumns = false
  ): string[] {
    const results: string[] = [];

    // Check if any core columns exist - if not, we'll return all columns as a fallback
    const hasCoreColumns = Object.values(tableSchema.columns).some(
      (col) => col.coreColumn === true && col.selectable !== false
    );

    // Only filter to core columns if the schema defines some core columns
    const shouldFilterToCoreOnly = onlyCoreColumns && hasCoreColumns;

    for (const [columnName, columnSchema] of Object.entries(tableSchema.columns)) {
      // Skip non-selectable columns
      if (columnSchema.selectable === false) {
        continue;
      }

      // If filtering to core columns only, skip non-core and track them
      if (shouldFilterToCoreOnly && !columnSchema.coreColumn) {
        this.hiddenColumns.push(columnName);
        continue;
      }

      // Build the SQL for this column
      let sqlResult: string;

      // Check if this is a virtual column (has expression)
      if (isVirtualColumn(columnSchema)) {
        // Virtual column: use the expression with an alias
        sqlResult = `(${columnSchema.expression}) AS ${this.printIdentifier(columnName)}`;
      } else if (columnSchema.textColumn) {
        // JSON column with text column optimization: use the text column with alias
        sqlResult = `${this.printIdentifier(columnSchema.textColumn)} AS ${this.printIdentifier(
          columnName
        )}`;
      } else {
        // Regular column: use the actual ClickHouse column name
        const clickhouseName = columnSchema.clickhouseName ?? columnName;

        // If the column has a different internal name, add an alias
        if (clickhouseName !== columnName) {
          sqlResult = `${this.printIdentifier(clickhouseName)} AS ${this.printIdentifier(
            columnName
          )}`;
        } else {
          sqlResult = this.printIdentifier(columnName);
        }
      }

      results.push(sqlResult);

      // Collect metadata if requested
      if (collectMetadata) {
        const metadata: OutputColumnMetadata = {
          name: columnName,
          type: columnSchema.type,
        };

        if (columnSchema.customRenderType) {
          metadata.customRenderType = columnSchema.customRenderType;
        }

        if (columnSchema.description) {
          metadata.description = columnSchema.description;
        }

        this.outputColumns.push(metadata);
      }
    }

    return results;
  }

  /**
   * Analyze a SELECT column expression to extract output name, source column, and type
   */
  private analyzeSelectColumn(col: Expression): {
    outputName: string | null;
    sourceColumn: Partial<ColumnSchema> | null;
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

      // For value-preserving aggregates (SUM, AVG, MIN, MAX), propagate customRenderType
      // from the source column. COUNT and other aggregates return counts, not values,
      // so they shouldn't inherit the source column's render type.
      const valuePreservingAggregates = [
        "sum",
        "sumif",
        "avg",
        "avgif",
        "min",
        "minif",
        "max",
        "maxif",
        "quantile",
      ];
      const funcName = call.name.toLowerCase();
      let sourceColumn: Partial<ColumnSchema> | null = null;

      if (valuePreservingAggregates.includes(funcName) && call.args.length > 0) {
        const firstArg = call.args[0];
        if ((firstArg as Field).expression_type === "field") {
          const field = firstArg as Field;
          const columnInfo = this.resolveFieldToColumn(field.chain);
          // Only propagate customRenderType, not the full column schema
          if (columnInfo.column?.customRenderType) {
            sourceColumn = {
              type: inferredType,
              customRenderType: columnInfo.column.customRenderType,
            };
          }
        }
      }

      return {
        outputName: this.generateImplicitName(call),
        sourceColumn,
        inferredType,
      };
    }

    // Handle ArithmeticOperation - infer type
    if ((col as ArithmeticOperation).expression_type === "arithmetic_operation") {
      const arith = col as ArithmeticOperation;
      const inferredType = this.inferArithmeticType(arith);
      return {
        outputName: this.generateImplicitName(arith),
        sourceColumn: null,
        inferredType,
      };
    }

    // Handle Constant
    if ((col as Constant).expression_type === "constant") {
      const constant = col as Constant;
      const inferredType = this.inferConstantType(constant);
      return {
        outputName: this.generateImplicitName(constant),
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
   * Generate an implicit column name for an expression without an explicit alias.
   * This matches how Postgres auto-names result columns (just the function name).
   *
   * Examples:
   * - COUNT() -> "count"
   * - COUNT(id) -> "count"
   * - SUM(duration_ms) -> "sum"
   * - 1 + 2 -> "plus"
   */
  private generateImplicitName(expr: Expression): string {
    // Handle Call (function/aggregation)
    if ((expr as Call).expression_type === "call") {
      const call = expr as Call;
      // Use lowercase function name without parentheses, like Postgres does
      // This allows users to reference the column in WHERE/HAVING without issues
      return call.name.toLowerCase();
    }

    // Handle Field
    if ((expr as Field).expression_type === "field") {
      const field = expr as Field;
      // Return the last part of the chain (column name)
      const parts = field.chain.filter((p): p is string => typeof p === "string");
      return parts.length > 0 ? parts[parts.length - 1] : "*";
    }

    // Handle ArithmeticOperation - use operator function name without args
    if ((expr as ArithmeticOperation).expression_type === "arithmetic_operation") {
      const arith = expr as ArithmeticOperation;

      switch (arith.op) {
        case ArithmeticOperationOp.Add:
          return "plus";
        case ArithmeticOperationOp.Sub:
          return "minus";
        case ArithmeticOperationOp.Mult:
          return "multiply";
        case ArithmeticOperationOp.Div:
          return "divide";
        case ArithmeticOperationOp.Mod:
          return "modulo";
        default:
          return "expression";
      }
    }

    // Handle Constant
    if ((expr as Constant).expression_type === "constant") {
      const constant = expr as Constant;
      if (constant.value === null) {
        return "NULL";
      }
      if (typeof constant.value === "string") {
        return `'${constant.value}'`;
      }
      return String(constant.value);
    }

    // Handle Alias (shouldn't normally reach here since aliases have explicit names)
    if ((expr as Alias).expression_type === "alias") {
      const alias = expr as Alias;
      return alias.alias;
    }

    // Default fallback
    return "expression";
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
    if (
      name === "count" ||
      name === "countif" ||
      name === "countdistinct" ||
      name === "countdistinctif"
    ) {
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

    // Quantile functions return Float64
    if (name === "quantile" || name === "quantileif" || name.startsWith("quantile")) {
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

        // Validate that required tenant columns are present in enforcedWhereClause
        this.validateRequiredTenantColumns(tableSchema);

        // Always add the TSQL table name as an alias if no explicit alias is provided
        // This ensures table-qualified column references work in WHERE clauses
        // (needed to avoid alias conflicts when columns have expressions)
        const effectiveAlias = node.alias || tableName;
        joinStrings.push(
          `${tableSchema.clickhouseName} AS ${this.printIdentifier(effectiveAlias)}`
        );

        // Register this table context for column name resolution
        this.tableContexts.set(effectiveAlias, tableSchema);

        // Register tenant columns as allowed internal columns
        // These are ClickHouse column names used for tenant isolation
        // Also mark them as internal-only if they're not exposed in tableSchema.columns
        if (tableSchema.tenantColumns) {
          const { organizationId, projectId, environmentId } = tableSchema.tenantColumns;
          if (organizationId) {
            this.allowedInternalColumns.add(organizationId);
            if (!this.isColumnExposedInSchema(tableSchema, organizationId)) {
              this.internalOnlyColumns.add(organizationId);
            }
          }
          if (projectId) {
            this.allowedInternalColumns.add(projectId);
            if (!this.isColumnExposedInSchema(tableSchema, projectId)) {
              this.internalOnlyColumns.add(projectId);
            }
          }
          if (environmentId) {
            this.allowedInternalColumns.add(environmentId);
            if (!this.isColumnExposedInSchema(tableSchema, environmentId)) {
              this.internalOnlyColumns.add(environmentId);
            }
          }
        }

        // Register required filter columns as allowed internal columns
        // These are ClickHouse columns used for internal filtering (e.g., engine = 'V2')
        // Also mark them as internal-only if they're not exposed in tableSchema.columns
        if (tableSchema.requiredFilters) {
          for (const filter of tableSchema.requiredFilters) {
            this.allowedInternalColumns.add(filter.column);
            if (!this.isColumnExposedInSchema(tableSchema, filter.column)) {
              this.internalOnlyColumns.add(filter.column);
            }
          }
        }

        // Add enforced WHERE clause guard (tenant isolation + plan limits)
        extraWhere = this.createEnforcedGuard(tableSchema, effectiveAlias);
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
  // Enforced WHERE Clause
  // ============================================================

  /**
   * Validate that required tenant columns are present in enforcedWhereClause.
   *
   * If a table defines `tenantColumns.organizationId`, the `enforcedWhereClause`
   * MUST include that column to ensure tenant isolation. This prevents accidental
   * data leaks when the caller forgets to include tenant isolation conditions.
   *
   * @throws QueryError if a required tenant column is missing
   */
  private validateRequiredTenantColumns(tableSchema: TableSchema): void {
    const { tenantColumns } = tableSchema;
    if (!tenantColumns) return;

    // Organization ID is always required if the table defines it
    if (tenantColumns.organizationId) {
      const orgColumn = tenantColumns.organizationId;
      if (!this.context.enforcedWhereClause[orgColumn]) {
        throw new QueryError(
          `Table '${tableSchema.name}' requires '${orgColumn}' in enforcedWhereClause for tenant isolation`
        );
      }
    }
    // Note: projectId and environmentId are optional - no validation needed
  }

  /**
   * Format a Date as a ClickHouse-compatible DateTime64 string.
   * ClickHouse expects format: 'YYYY-MM-DD HH:MM:SS.mmm' (in UTC)
   */
  private formatDateForClickHouse(date: Date): string {
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
   * Create an AST expression for a value.
   * Date values are wrapped in toDateTime64() for ClickHouse compatibility.
   */
  private createValueExpression(value: Date | string | number): Expression {
    if (value instanceof Date) {
      // Wrap Date in toDateTime64(formatted_string, 3) for ClickHouse DateTime64(3) columns
      return {
        expression_type: "call",
        name: "toDateTime64",
        args: [
          { expression_type: "constant", value: this.formatDateForClickHouse(value) } as Constant,
          { expression_type: "constant", value: 3 } as Constant,
        ],
      } as Call;
    }
    return { expression_type: "constant", value } as Constant;
  }

  /**
   * Map condition operator to CompareOperationOp
   */
  private mapConditionOpToCompareOp(
    op: "eq" | "neq" | "gt" | "gte" | "lt" | "lte"
  ): CompareOperationOp {
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
   * Create an AST expression from a WhereClauseCondition
   *
   * @param column - The column name
   * @param condition - The condition to apply
   * @param tableAlias - Optional table alias to qualify the column reference.
   *                     When provided, constructs the field chain as [tableAlias, column]
   *                     so resolveFieldChain will resolve to the correct table in multi-join queries.
   * @returns The AST expression for the condition
   */
  private createConditionExpression(
    column: string,
    condition: WhereClauseCondition,
    tableAlias?: string
  ): Expression {
    // When tableAlias is provided, qualify the field chain to ensure it binds
    // to the correct table in multi-join queries
    const fieldExpr: Field = {
      expression_type: "field",
      chain: tableAlias ? [tableAlias, column] : [column],
    };

    if (condition.op === "between") {
      const betweenExpr: BetweenExpr = {
        expression_type: "between_expr",
        expr: fieldExpr,
        low: this.createValueExpression(condition.low),
        high: this.createValueExpression(condition.high),
      };
      return betweenExpr;
    }

    // Simple comparison
    const compareExpr: CompareOperation = {
      expression_type: "compare_operation",
      left: fieldExpr,
      right: this.createValueExpression(condition.value),
      op: this.mapConditionOpToCompareOp(condition.op),
    };
    return compareExpr;
  }

  /**
   * Create a WHERE clause expression for enforced conditions and required filters.
   *
   * This method applies:
   * 1. All conditions from enforcedWhereClause (tenant isolation + plan limits)
   * 2. Required filters from the table schema (e.g., engine = 'V2')
   *
   * Conditions are applied if the column exists in either:
   * - The exposed columns (tableSchema.columns)
   * - The tenant columns (tableSchema.tenantColumns)
   *
   * This ensures the same enforcedWhereClause can be used across different tables.
   *
   * All guard expressions are qualified with the table alias to ensure they bind
   * to the correct table in multi-join queries, preventing potential security
   * issues where an unqualified column reference could bind to the wrong table.
   */
  private createEnforcedGuard(tableSchema: TableSchema, tableAlias: string): Expression | null {
    const { requiredFilters, tenantColumns } = tableSchema;
    const guards: Expression[] = [];

    // Build a set of valid columns for this table (exposed + tenant columns)
    const validColumns = new Set<string>(Object.keys(tableSchema.columns));
    if (tenantColumns) {
      if (tenantColumns.organizationId) validColumns.add(tenantColumns.organizationId);
      if (tenantColumns.projectId) validColumns.add(tenantColumns.projectId);
      if (tenantColumns.environmentId) validColumns.add(tenantColumns.environmentId);
    }

    // Apply all enforced conditions for columns that exist in this table
    // Pass tableAlias to ensure guards are qualified and bind to the correct table
    for (const [column, condition] of Object.entries(this.context.enforcedWhereClause)) {
      // Skip undefined/null conditions (allows conditional inclusion like project_id?: condition)
      if (condition === undefined || condition === null) {
        continue;
      }
      // Only apply if column exists in this table's schema or is a tenant column
      if (validColumns.has(column)) {
        guards.push(this.createConditionExpression(column, condition, tableAlias));
      }
    }

    // Add required filters from the table schema (e.g., engine = 'V2')
    // Also qualified with table alias to ensure correct binding in multi-join queries
    if (requiredFilters && requiredFilters.length > 0) {
      for (const filter of requiredFilters) {
        const filterGuard: CompareOperation = {
          expression_type: "compare_operation",
          op: CompareOperationOp.Eq,
          left: { expression_type: "field", chain: [tableAlias, filter.column] } as Field,
          right: { expression_type: "constant", value: filter.value } as Constant,
        };
        guards.push(filterGuard);
      }
    }

    // Return null if no guards (empty enforcedWhereClause and no requiredFilters)
    if (guards.length === 0) {
      return null;
    }

    // If only one guard, return it directly (no need for AND wrapper)
    if (guards.length === 1) {
      return guards[0];
    }

    return {
      expression_type: "and",
      exprs: guards,
    } as And;
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
    const rightColumnSchema = this.extractColumnSchemaFromExpression(node.right);

    // Transform the right side if it contains user-friendly values
    const transformedRight = this.transformValueMapExpression(node.right, columnSchema);

    // Check if we should use a text column for bare JSON field comparisons
    // This applies to: Eq, NotEq, Like, ILike, NotLike, NotILike
    const textColumnOps = [
      CompareOperationOp.Eq,
      CompareOperationOp.NotEq,
      CompareOperationOp.Like,
      CompareOperationOp.ILike,
      CompareOperationOp.NotLike,
      CompareOperationOp.NotILike,
    ];
    const useTextColumn = textColumnOps.includes(node.op);
    const leftTextColumn = useTextColumn ? this.getTextColumnForExpression(node.left) : null;

    // Build the left side, qualifying the text column with table alias if present
    let left: string;
    if (leftTextColumn) {
      // Check if the field is qualified with a table alias (e.g., r.output)
      // and prepend that alias to the text column to avoid ambiguity in JOINs
      const fieldNode = node.left as Field;
      if (fieldNode.expression_type === "field" && fieldNode.chain.length >= 2) {
        const firstPart = fieldNode.chain[0];
        if (typeof firstPart === "string" && this.tableContexts.has(firstPart)) {
          // The field is qualified with a table alias, prepend it to the text column
          left = this.printIdentifier(firstPart) + "." + this.printIdentifier(leftTextColumn);
        } else {
          left = this.printIdentifier(leftTextColumn);
        }
      } else {
        left = this.printIdentifier(leftTextColumn);
      }
    } else {
      left = this.visit(node.left);
    }
    const right = this.visit(transformedRight);

    switch (node.op) {
      case CompareOperationOp.Eq:
        // Handle NULL comparison
        if (
          (transformedRight as Constant).expression_type === "constant" &&
          (transformedRight as Constant).value === null
        ) {
          // Check if the column has a custom nullValue (e.g., '{}' for JSON columns)
          if (columnSchema?.nullValue) {
            return `equals(${left}, ${columnSchema.nullValue})`;
          }
          return `isNull(${left})`;
        }
        if (
          (node.left as Constant).expression_type === "constant" &&
          (node.left as Constant).value === null
        ) {
          // Check if the column has a custom nullValue (e.g., '{}' for JSON columns)
          if (rightColumnSchema?.nullValue) {
            return `equals(${right}, ${rightColumnSchema.nullValue})`;
          }
          return `isNull(${right})`;
        }
        return `equals(${left}, ${right})`;

      case CompareOperationOp.NotEq:
        // Handle NULL comparison
        if (
          (transformedRight as Constant).expression_type === "constant" &&
          (transformedRight as Constant).value === null
        ) {
          // Check if the column has a custom nullValue (e.g., '{}' for JSON columns)
          if (columnSchema?.nullValue) {
            return `notEquals(${left}, ${columnSchema.nullValue})`;
          }
          return `isNotNull(${left})`;
        }
        if (
          (node.left as Constant).expression_type === "constant" &&
          (node.left as Constant).value === null
        ) {
          // Check if the column has a custom nullValue (e.g., '{}' for JSON columns)
          if (rightColumnSchema?.nullValue) {
            return `notEquals(${right}, ${rightColumnSchema.nullValue})`;
          }
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
   * Transform a single string value using whereTransform, valueMap, or fieldMapping
   * Returns the transformed value, or the original value if no transformation applies
   */
  private transformSingleValue(columnSchema: ColumnSchema, value: string): string {
    // First try whereTransform function (highest priority)
    if (columnSchema.whereTransform) {
      return columnSchema.whereTransform(value);
    }

    // Then try static valueMap
    if (columnSchema.valueMap) {
      const internalValue = getInternalValue(columnSchema, value);
      if (internalValue !== value) {
        return internalValue;
      }
    }

    // Then try runtime fieldMapping
    if (hasFieldMapping(columnSchema) && columnSchema.fieldMapping) {
      const internalValue = getInternalValueFromMappingCaseInsensitive(
        this.context.fieldMappings,
        columnSchema.fieldMapping,
        value
      );
      if (internalValue !== null) {
        return internalValue;
      }
    }

    return value;
  }

  /**
   * Transform an expression's values using the column's whereTransform, valueMap, or fieldMapping if applicable
   * Returns the original expression if no transformation is needed
   */
  private transformValueMapExpression(
    expr: Expression,
    columnSchema: ColumnSchema | null
  ): Expression {
    // No column schema, return as-is
    if (!columnSchema) {
      return expr;
    }

    // Check if column has any transformation mechanism
    const hasWhereTransform = columnSchema.whereTransform !== undefined;
    const hasValueMap = columnSchema.valueMap && Object.keys(columnSchema.valueMap).length > 0;
    const hasFieldMap = hasFieldMapping(columnSchema);
    if (!hasWhereTransform && !hasValueMap && !hasFieldMap) {
      return expr;
    }

    // Handle constant string values
    if ((expr as Constant).expression_type === "constant") {
      const constant = expr as Constant;
      if (typeof constant.value === "string") {
        const internalValue = this.transformSingleValue(columnSchema, constant.value);
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
    // BUT: if the column has whereTransform and we're in a comparison context,
    // use the raw column instead of the expression (for efficient index usage)
    const columnSchema = this.resolveFieldToColumnSchema(node.chain);
    const inComparisonContext = this.isInComparisonContext();

    if (columnSchema?.whereTransform && inComparisonContext) {
      // Use raw column for WHERE comparisons when whereTransform is defined
      // Must table-qualify to avoid alias conflicts with SELECT expressions
      const tableQualifiedChain = this.resolveFieldChainWithTableAlias(node.chain);
      return tableQualifiedChain.map((part) => this.printIdentifierOrIndex(part)).join(".");
    }

    // In GROUP BY context, for virtual columns (columns with expressions),
    // use the alias name instead of the expression. ClickHouse allows
    // referencing SELECT aliases in GROUP BY.
    if (this.inGroupByContext) {
      const virtualColumnName = this.getVirtualColumnNameForField(node.chain);
      if (virtualColumnName !== null) {
        return this.printIdentifier(virtualColumnName);
      }
    }

    const virtualExpression = this.getVirtualColumnExpressionForField(node.chain);
    if (virtualExpression !== null) {
      // Return the expression wrapped in parentheses
      return `(${virtualExpression})`;
    }

    // Inject dataPrefix for JSON columns if needed (e.g., output.message -> output.data.message)
    const chainWithPrefix = this.injectDataPrefix(node.chain);

    // Try to resolve column names through table context
    const resolvedChain = this.resolveFieldChain(chainWithPrefix);

    // Print each chain element
    let result = resolvedChain.map((part) => this.printIdentifierOrIndex(part)).join(".");

    // For JSON column subfield access (e.g., error.data.name), add .:String type hint
    // This is ONLY required when the query has GROUP BY, because:
    // 1. ClickHouse's Dynamic/Variant types are not allowed in GROUP BY without type casting
    // 2. SELECT/GROUP BY expressions must match
    // For queries without GROUP BY, the .:String type hint actually breaks the query
    // (returns NULL instead of the actual value)
    // We also skip this in WHERE comparisons where it breaks the query
    if (resolvedChain.length > 1) {
      // Check if the root column (first part) is a JSON column
      const rootColumnSchema = this.resolveFieldToColumnSchema([node.chain[0]]);
      // Add .:String ONLY for GROUP BY queries, and NOT in WHERE comparisons
      if (
        rootColumnSchema?.type === "JSON" &&
        this.queryHasGroupBy &&
        !this.isInWhereComparisonContext()
      ) {
        // Add .:String type hint for JSON subfield access
        result = `${result}.:String`;
      }
    }

    return result;
  }

  /**
   * Check if we're in a context where we should use raw column names
   * instead of virtual column expressions (WHERE comparisons or GROUP BY)
   */
  private isInComparisonContext(): boolean {
    // Check if we're in GROUP BY context
    if (this.inGroupByContext) {
      return true;
    }

    // Check if we're inside a comparison operation (WHERE/HAVING context)
    for (const node of this.stack) {
      if ((node as CompareOperation).expression_type === "compare_operation") {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if we're inside a WHERE/HAVING comparison operation.
   * Unlike isInComparisonContext(), this does NOT include GROUP BY context.
   * Used to skip .:String type hints in WHERE clauses where they break queries.
   */
  private isInWhereComparisonContext(): boolean {
    for (const node of this.stack) {
      if ((node as CompareOperation).expression_type === "compare_operation") {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolve field chain with table alias prefix to avoid alias conflicts.
   * This is used in WHERE clauses when a column has whereTransform to ensure
   * we reference the raw column, not a SELECT alias with the same name.
   */
  private resolveFieldChainWithTableAlias(chain: Array<string | number>): Array<string | number> {
    if (chain.length === 0) return chain;

    const firstPart = chain[0];
    if (typeof firstPart !== "string") return chain;

    // If already qualified (table.column), use normal resolution
    if (chain.length >= 2) {
      return this.resolveFieldChain(chain);
    }

    // Unqualified reference - need to find the table and add its alias
    const columnName = firstPart;
    for (const [tableAlias, tableSchema] of this.tableContexts.entries()) {
      const columnSchema = tableSchema.columns[columnName];
      if (columnSchema) {
        const resolvedColumnName = columnSchema.clickhouseName || columnSchema.name;
        return [tableAlias, resolvedColumnName, ...chain.slice(1)];
      }
    }

    // Not found in any table - return as-is
    return chain;
  }

  /**
   * Check if a field chain represents JSON subfield access (e.g., error.data.name)
   * Returns true if the root column is JSON type and there are additional path parts
   */
  private isJsonSubfieldAccess(chain: Array<string | number>): boolean {
    if (chain.length <= 1) return false;

    const rootColumnSchema = this.resolveFieldToColumnSchema([chain[0]]);
    return rootColumnSchema?.type === "JSON";
  }

  /**
   * Check if a field should use a text column instead of the JSON column.
   * Returns the text column name if the field is a bare JSON field with textColumn defined,
   * or null if the original column should be used.
   *
   * A "bare" JSON field means selecting the entire column (e.g., SELECT output)
   * rather than accessing a subfield (e.g., SELECT output.data.name).
   */
  private getTextColumnForField(chain: Array<string | number>): string | null {
    if (chain.length === 0) return null;

    const firstPart = chain[0];
    if (typeof firstPart !== "string") return null;

    let columnSchema: ColumnSchema | null = null;

    if (chain.length === 1) {
      // Unqualified: just column name
      columnSchema = this.resolveFieldToColumnSchema(chain);
    } else if (chain.length === 2) {
      // Could be table.column (qualified) - check if first part is a table alias
      const tableSchema = this.tableContexts.get(firstPart);
      if (tableSchema) {
        const columnName = chain[1];
        if (typeof columnName === "string") {
          columnSchema = tableSchema.columns[columnName] || null;
        }
      }
      // If not a table alias, it's JSON path access (e.g., output.data) - return null
    }
    // chain.length > 2 means JSON path access - return null

    return columnSchema?.textColumn ?? null;
  }

  /**
   * Get the text column for an expression if it's a bare JSON field.
   * Returns null if the expression is not a field or doesn't have a textColumn.
   */
  private getTextColumnForExpression(expr: Expression): string | null {
    if ((expr as Field).expression_type !== "field") return null;
    return this.getTextColumnForField((expr as Field).chain);
  }

  /**
   * Get the dataPrefix for a field chain if the root column has one defined.
   * Returns null if the column doesn't have a dataPrefix or if this isn't a subfield access.
   */
  private getDataPrefixForField(chain: Array<string | number>): string | null {
    if (chain.length < 2) return null; // Need at least column.subfield

    const firstPart = chain[0];
    if (typeof firstPart !== "string") return null;

    // Check if first part is a table alias (table.column.subfield)
    const tableSchema = this.tableContexts.get(firstPart);
    if (tableSchema) {
      // Qualified: table.column.subfield - need at least 3 parts
      if (chain.length < 3) return null;
      const columnName = chain[1];
      if (typeof columnName !== "string") return null;
      const columnSchema = tableSchema.columns[columnName];
      return columnSchema?.dataPrefix ?? null;
    }

    // Unqualified: column.subfield
    const columnSchema = this.resolveFieldToColumnSchema([firstPart]);
    return columnSchema?.dataPrefix ?? null;
  }

  /**
   * Inject dataPrefix into a field chain if the root column has one defined.
   * e.g., [output, message] -> [output, data, message] when dataPrefix is "data"
   * Returns the original chain if no dataPrefix applies.
   */
  private injectDataPrefix(chain: Array<string | number>): Array<string | number> {
    const dataPrefix = this.getDataPrefixForField(chain);
    if (!dataPrefix) return chain;

    const firstPart = chain[0];
    if (typeof firstPart !== "string") return chain;

    // Check if first part is a table alias
    const tableSchema = this.tableContexts.get(firstPart);
    if (tableSchema) {
      // Qualified: table.column.subfield -> table.column.dataPrefix.subfield
      // [table, column, subfield] -> [table, column, dataPrefix, subfield]
      return [chain[0], chain[1], dataPrefix, ...chain.slice(2)];
    }

    // Unqualified: column.subfield -> column.dataPrefix.subfield
    // [column, subfield] -> [column, dataPrefix, subfield]
    return [chain[0], dataPrefix, ...chain.slice(1)];
  }

  /**
   * Build an alias name for a field chain, excluding the dataPrefix if present.
   * e.g., [output, message] with dataPrefix "data" -> "output_message"
   * This gives users clean column names without the internal data wrapper.
   */
  private buildAliasWithoutDataPrefix(
    chain: Array<string | number>,
    dataPrefix: string | null
  ): string {
    // Filter to just string parts and join with underscores
    const parts = chain.filter((p): p is string => typeof p === "string");

    if (dataPrefix) {
      // Remove the dataPrefix from the parts (it's an implementation detail)
      const prefixIndex = parts.indexOf(dataPrefix);
      if (prefixIndex > 0) {
        // Only remove if it's not the first element (column name)
        parts.splice(prefixIndex, 1);
      }
    }

    return parts.join("_");
  }

  /**
   * Resolve a field chain to its column schema (if it references a known column)
   */
  private resolveFieldToColumnSchema(chain: Array<string | number>): ColumnSchema | null {
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
   *
   * @throws QueryError if the column is not found in any table schema and is not a SELECT alias
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
          const resolvedColumn = this.resolveColumnName(tableSchema, columnName, tableAlias);
          return [tableAlias, resolvedColumn, ...chain.slice(2)];
        }
      }
      // Not a known table alias, might be a nested field or JSON path - return as-is
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

    // Check if it's a SELECT alias (e.g., from COUNT() or explicit AS)
    if (this.selectAliases.has(columnName)) {
      return chain; // Valid alias reference
    }

    // Check if this is an internal-only column being accessed in a user projection context
    // (SELECT, ORDER BY, GROUP BY, HAVING). These columns are used internally for
    // tenant isolation but should not be user-queryable unless explicitly exposed.
    if (this.inProjectionContext && this.internalOnlyColumns.has(columnName)) {
      const availableColumns = this.getAvailableColumnNames();
      throw new QueryError(
        `Column "${columnName}" is not available for querying. Available columns: ${availableColumns.join(
          ", "
        )}`
      );
    }

    // Check if this is an allowed internal column (e.g., tenant columns)
    // These are ClickHouse column names that are allowed for internal use only
    // (e.g., in WHERE clauses for tenant isolation)
    if (this.allowedInternalColumns.has(columnName)) {
      return chain;
    }

    // Column not found in any table context and not a SELECT alias
    // This is a security issue - block access to unknown columns
    if (this.tableContexts.size > 0) {
      // Only throw if we have tables in context (otherwise might be subquery)
      // Check if the user typed a ClickHouse column name instead of the TSQL name
      const suggestion = this.findTSQLNameForClickHouseName(columnName);
      if (suggestion) {
        throw new QueryError(`Unknown column "${columnName}". Did you mean "${suggestion}"?`);
      }

      const availableColumns = this.getAvailableColumnNames();
      throw new QueryError(
        `Unknown column "${columnName}". Available columns: ${availableColumns.join(", ")}`
      );
    }

    // No tables in context (might be FROM subquery without alias) - return as-is
    return chain;
  }

  /**
   * Get list of available column names from all tables in context
   */
  private getAvailableColumnNames(): string[] {
    const columns: string[] = [];
    for (const tableSchema of this.tableContexts.values()) {
      columns.push(...Object.keys(tableSchema.columns));
    }
    return [...new Set(columns)].sort();
  }

  /**
   * Check if a ClickHouse column name is exposed in the table schema's public columns.
   * A column is considered exposed if:
   * - It exists as a column name in tableSchema.columns, OR
   * - It is the clickhouseName of a column in tableSchema.columns
   *
   * @param tableSchema The table schema to check
   * @param clickhouseColumnName The ClickHouse column name to check
   * @returns true if the column is exposed to users, false if it's internal-only
   */
  private isColumnExposedInSchema(tableSchema: TableSchema, clickhouseColumnName: string): boolean {
    for (const [tsqlName, columnSchema] of Object.entries(tableSchema.columns)) {
      // Check if the ClickHouse column name matches either:
      // 1. The TSQL name (if no clickhouseName mapping exists)
      // 2. The explicit clickhouseName mapping
      const actualClickhouseName = columnSchema.clickhouseName || tsqlName;
      if (actualClickhouseName === clickhouseColumnName) {
        return true;
      }
    }
    return false;
  }

  /**
   * Find the TSQL column name for a given ClickHouse column name.
   * This is used to provide helpful suggestions when users accidentally
   * use internal ClickHouse column names instead of TSQL names.
   *
   * @returns The TSQL column name if found, null otherwise
   */
  private findTSQLNameForClickHouseName(clickhouseName: string): string | null {
    for (const tableSchema of this.tableContexts.values()) {
      for (const [tsqlName, columnSchema] of Object.entries(tableSchema.columns)) {
        if (columnSchema.clickhouseName === clickhouseName) {
          return tsqlName;
        }
      }
    }
    return null;
  }

  /**
   * Resolve a column name to its ClickHouse name using the table schema
   *
   * @throws QueryError if the column is not found in the table schema
   */
  private resolveColumnName(
    tableSchema: TableSchema,
    columnName: string,
    tableAlias?: string
  ): string {
    const columnSchema = tableSchema.columns[columnName];
    if (columnSchema) {
      return columnSchema.clickhouseName || columnSchema.name;
    }

    // Check if this is a tenant column that's not exposed in the schema's columns
    // These are internal columns used for tenant isolation guards
    const { tenantColumns, requiredFilters } = tableSchema;
    if (tenantColumns) {
      if (
        columnName === tenantColumns.organizationId ||
        columnName === tenantColumns.projectId ||
        columnName === tenantColumns.environmentId
      ) {
        // Tenant columns are already ClickHouse column names, return as-is
        return columnName;
      }
    }

    // Check if this is a required filter column (e.g., engine = 'V2')
    // These are internal columns used for enforced filters
    if (requiredFilters) {
      for (const filter of requiredFilters) {
        if (columnName === filter.column) {
          // Required filter columns are already ClickHouse column names, return as-is
          return columnName;
        }
      }
    }

    // Column not in schema - this is a security issue, block access
    // Check if the user typed a ClickHouse column name instead of the TSQL name
    for (const [tsqlName, colSchema] of Object.entries(tableSchema.columns)) {
      if (colSchema.clickhouseName === columnName) {
        throw new QueryError(`Unknown column "${columnName}". Did you mean "${tsqlName}"?`);
      }
    }

    const availableColumns = Object.keys(tableSchema.columns).sort().join(", ");
    const tableName = tableAlias || tableSchema.name;
    throw new QueryError(
      `Unknown column "${columnName}" on table "${tableName}". Available columns: ${availableColumns}`
    );
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
