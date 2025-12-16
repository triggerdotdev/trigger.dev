// Schema validation for TSQL queries
// Validates column names and enum values against the schema

import type {
  SelectQuery,
  SelectSetQuery,
  Expression,
  Field,
  CompareOperation,
  Constant,
  And,
  Or,
  Not,
  Alias,
  OrderExpr,
  Call,
  JoinExpr,
  BetweenExpr,
  Array as ASTArray,
} from "./ast.js";
import type { TableSchema, ColumnSchema } from "./schema.js";
import { CompareOperationOp } from "./ast.js";

/**
 * Severity of a validation issue
 */
export type ValidationSeverity = "error" | "warning" | "info";

/**
 * A validation issue found in the query
 */
export interface ValidationIssue {
  /** The error/warning message */
  message: string;
  /** Severity of the issue */
  severity: ValidationSeverity;
  /** The type of issue */
  type: "unknown_column" | "unknown_table" | "invalid_enum_value";
  /** Optional: the column name that caused the issue */
  columnName?: string;
  /** Optional: the table name that caused the issue */
  tableName?: string;
  /** Optional: the invalid value */
  invalidValue?: string;
  /** Optional: list of allowed values */
  allowedValues?: string[];
}

/**
 * Result of validating a query
 */
export interface ValidationResult {
  /** Whether the query is valid */
  valid: boolean;
  /** List of issues found */
  issues: ValidationIssue[];
}

/**
 * Context for tracking tables and columns during validation
 */
interface ValidationContext {
  /** Map of table aliases/names to their schemas */
  tables: Map<string, TableSchema>;
  /** The schema array for lookups */
  schema: TableSchema[];
  /** Accumulated issues */
  issues: ValidationIssue[];
}

/**
 * Validate a parsed TSQL query against a schema
 *
 * @param ast - The parsed query AST
 * @param schema - Array of table schemas to validate against
 * @returns Validation result with any issues found
 */
export function validateQuery(
  ast: SelectQuery | SelectSetQuery,
  schema: TableSchema[]
): ValidationResult {
  const context: ValidationContext = {
    tables: new Map(),
    schema,
    issues: [],
  };

  if (ast.expression_type === "select_set_query") {
    validateSelectSetQuery(ast, context);
  } else {
    validateSelectQuery(ast, context);
  }

  return {
    valid: context.issues.filter((i) => i.severity === "error").length === 0,
    issues: context.issues,
  };
}

/**
 * Validate a SELECT SET query (UNION, INTERSECT, etc.)
 */
function validateSelectSetQuery(node: SelectSetQuery, context: ValidationContext): void {
  if (node.initial_select_query.expression_type === "select_set_query") {
    validateSelectSetQuery(node.initial_select_query, context);
  } else {
    validateSelectQuery(node.initial_select_query, context);
  }

  for (const subsequent of node.subsequent_select_queries) {
    if (subsequent.select_query.expression_type === "select_set_query") {
      validateSelectSetQuery(subsequent.select_query as SelectSetQuery, context);
    } else {
      validateSelectQuery(subsequent.select_query as SelectQuery, context);
    }
  }
}

/**
 * Validate a SELECT query
 */
function validateSelectQuery(node: SelectQuery, context: ValidationContext): void {
  // First, extract tables from FROM clause to build context
  if (node.select_from) {
    extractTablesFromJoin(node.select_from, context);
  }

  // Validate SELECT columns
  if (node.select) {
    for (const expr of node.select) {
      validateExpression(expr, context);
    }
  }

  // Validate WHERE clause
  if (node.where) {
    validateExpression(node.where, context);
  }

  // Validate GROUP BY
  if (node.group_by) {
    for (const expr of node.group_by) {
      validateExpression(expr, context);
    }
  }

  // Validate HAVING
  if (node.having) {
    validateExpression(node.having, context);
  }

  // Validate ORDER BY
  if (node.order_by) {
    for (const expr of node.order_by) {
      validateExpression(expr, context);
    }
  }
}

/**
 * Extract table schemas from JOIN expressions
 */
function extractTablesFromJoin(node: JoinExpr, context: ValidationContext): void {
  if (node.table) {
    const tableExpr = node.table;

    if ((tableExpr as Field).expression_type === "field") {
      const field = tableExpr as Field;
      const tableName = field.chain[0];

      if (typeof tableName === "string") {
        // Find the table schema
        const tableSchema = context.schema.find(
          (t) => t.name.toLowerCase() === tableName.toLowerCase()
        );

        if (tableSchema) {
          // Register with alias if provided, otherwise use table name
          const key = node.alias || tableName;
          context.tables.set(key.toLowerCase(), tableSchema);
        } else {
          // Unknown table
          context.issues.push({
            message: `Unknown table "${tableName}". Available tables: ${
              context.schema.map((t) => t.name).join(", ") || "(none)"
            }`,
            severity: "warning",
            type: "unknown_table",
            tableName,
          });
        }
      }
    } else if (
      (tableExpr as SelectQuery).expression_type === "select_query" ||
      (tableExpr as SelectSetQuery).expression_type === "select_set_query"
    ) {
      // Subquery - validate it recursively
      if ((tableExpr as SelectSetQuery).expression_type === "select_set_query") {
        validateSelectSetQuery(tableExpr as SelectSetQuery, context);
      } else {
        validateSelectQuery(tableExpr as SelectQuery, context);
      }
    }
  }

  // Process next join in chain
  if (node.next_join) {
    extractTablesFromJoin(node.next_join, context);
  }
}

/**
 * Validate an expression and its children
 */
function validateExpression(expr: Expression, context: ValidationContext): void {
  if (!expr || typeof expr !== "object") return;

  const exprType = expr.expression_type;

  switch (exprType) {
    case "field":
      validateField(expr as Field, context);
      break;

    case "compare_operation":
      validateCompareOperation(expr as CompareOperation, context);
      break;

    case "and":
      for (const e of (expr as And).exprs) {
        validateExpression(e, context);
      }
      break;

    case "or":
      for (const e of (expr as Or).exprs) {
        validateExpression(e, context);
      }
      break;

    case "not":
      validateExpression((expr as Not).expr, context);
      break;

    case "alias":
      validateExpression((expr as Alias).expr, context);
      break;

    case "order_expr":
      validateExpression((expr as OrderExpr).expr, context);
      break;

    case "call":
      for (const arg of (expr as Call).args) {
        validateExpression(arg, context);
      }
      break;

    case "between_expr":
      validateExpression((expr as BetweenExpr).expr, context);
      validateExpression((expr as BetweenExpr).low, context);
      validateExpression((expr as BetweenExpr).high, context);
      break;

    case "array":
      for (const e of (expr as ASTArray).exprs) {
        validateExpression(e, context);
      }
      break;

    // Other expression types that we don't need to deeply validate
    case "constant":
    case "select_query":
    case "select_set_query":
      // Skip - constants don't need validation, subqueries are handled separately
      break;
  }
}

/**
 * Validate a field reference
 */
function validateField(field: Field, context: ValidationContext): void {
  const chain = field.chain;
  if (chain.length === 0) return;

  // Handle asterisk
  if (chain[0] === "*") return;
  if (chain.length === 2 && chain[1] === "*") return;

  const firstPart = chain[0];
  if (typeof firstPart !== "string") return;

  // Case 1: Qualified reference like table.column
  if (chain.length >= 2) {
    const tableAlias = firstPart.toLowerCase();
    const columnName = chain[1];

    if (typeof columnName !== "string") return;

    const tableSchema = context.tables.get(tableAlias);
    if (tableSchema) {
      // Check if column exists
      if (!tableSchema.columns[columnName]) {
        const availableColumns = Object.keys(tableSchema.columns).join(", ");
        context.issues.push({
          message: `Unknown column "${columnName}" on table "${tableAlias}". Available columns: ${availableColumns}`,
          severity: "warning",
          type: "unknown_column",
          columnName,
          tableName: tableAlias,
        });
      }
    }
    return;
  }

  // Case 2: Unqualified reference - try to find in any table
  const columnName = firstPart;
  let found = false;

  for (const tableSchema of context.tables.values()) {
    if (tableSchema.columns[columnName]) {
      found = true;
      break;
    }
  }

  if (!found && context.tables.size > 0) {
    // Only report if we have tables to check against
    const allColumns = new Set<string>();
    for (const tableSchema of context.tables.values()) {
      for (const col of Object.keys(tableSchema.columns)) {
        allColumns.add(col);
      }
    }
    context.issues.push({
      message: `Unknown column "${columnName}". Available columns: ${Array.from(allColumns).join(
        ", "
      )}`,
      severity: "warning",
      type: "unknown_column",
      columnName,
    });
  }
}

/**
 * Validate a comparison operation, including enum value checks
 */
function validateCompareOperation(op: CompareOperation, context: ValidationContext): void {
  // Validate both sides recursively
  validateExpression(op.left, context);
  validateExpression(op.right, context);

  // Check for enum value validation
  // We look for patterns like: column = 'value' or column IN ('value1', 'value2')
  const columnInfo = extractColumnFromExpression(op.left, context);
  if (!columnInfo) return;

  const { columnSchema, columnName, tableName } = columnInfo;

  // Only validate if the column has allowedValues
  if (!columnSchema.allowedValues || columnSchema.allowedValues.length === 0) return;

  // Check the comparison type
  switch (op.op) {
    case CompareOperationOp.Eq:
    case CompareOperationOp.NotEq:
      // Single value comparison
      validateEnumValue(op.right, columnSchema, columnName, tableName, context);
      break;

    case CompareOperationOp.In:
    case CompareOperationOp.NotIn:
    case CompareOperationOp.GlobalIn:
    case CompareOperationOp.GlobalNotIn:
      // Array of values
      if ((op.right as ASTArray).expression_type === "array") {
        for (const elem of (op.right as ASTArray).exprs) {
          validateEnumValue(elem, columnSchema, columnName, tableName, context);
        }
      }
      break;
  }
}

/**
 * Extract column information from an expression if it's a simple column reference
 */
function extractColumnFromExpression(
  expr: Expression,
  context: ValidationContext
): { columnSchema: ColumnSchema; columnName: string; tableName?: string } | null {
  if ((expr as Field).expression_type !== "field") return null;

  const field = expr as Field;
  const chain = field.chain;

  if (chain.length === 0) return null;

  const firstPart = chain[0];
  if (typeof firstPart !== "string") return null;

  // Qualified reference: table.column
  if (chain.length >= 2) {
    const tableAlias = firstPart.toLowerCase();
    const columnName = chain[1];

    if (typeof columnName !== "string") return null;

    const tableSchema = context.tables.get(tableAlias);
    if (!tableSchema) return null;

    const columnSchema = tableSchema.columns[columnName];
    if (!columnSchema) return null;

    return { columnSchema, columnName, tableName: tableAlias };
  }

  // Unqualified reference
  const columnName = firstPart;
  for (const [tableName, tableSchema] of context.tables.entries()) {
    const columnSchema = tableSchema.columns[columnName];
    if (columnSchema) {
      return { columnSchema, columnName, tableName };
    }
  }

  return null;
}

/**
 * Validate that a value matches the allowed enum values for a column
 */
function validateEnumValue(
  expr: Expression,
  columnSchema: ColumnSchema,
  columnName: string,
  tableName: string | undefined,
  context: ValidationContext
): void {
  if ((expr as Constant).expression_type !== "constant") return;

  const constant = expr as Constant;
  if (typeof constant.value !== "string") return;

  const value = constant.value;
  const allowedValues = columnSchema.allowedValues!;

  if (!allowedValues.includes(value)) {
    const columnRef = tableName ? `${tableName}.${columnName}` : columnName;
    context.issues.push({
      message: `Invalid value "${value}" for column "${columnRef}". Allowed values: ${allowedValues.join(
        ", "
      )}`,
      severity: "error",
      type: "invalid_enum_value",
      columnName,
      tableName,
      invalidValue: value,
      allowedValues,
    });
  }
}
