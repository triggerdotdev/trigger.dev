// TypeScript translation of posthog/hogql/ast.py
// Keep this file in sync with the Python version

import type { HogQLContext } from "./context";
import type {
  DatabaseField,
  ExpressionField,
  FieldOrTable,
  FieldTraverser,
  LazyJoin,
  LazyTable,
  StringArrayDatabaseField,
  StringJSONDatabaseField,
  Table,
  UnknownDatabaseField,
  VirtualTable,
} from "./models";
import type { ConstantDataType, HogQLQuerySettings } from "./constants";

// Base types
export interface AST {
  start?: number;
  end?: number;
  accept?(visitor: any): any;
}

export interface Type extends AST {
  get_child?(name: string, context: HogQLContext): Type;
  has_child?(name: string, context: HogQLContext): boolean;
  resolve_constant_type?(context: HogQLContext): ConstantType;
  resolve_column_constant_type?(name: string, context: HogQLContext): ConstantType;
}

export interface Expr extends AST {
  type?: Type;
}

export interface ConstantType extends Type {
  data_type: ConstantDataType;
  nullable?: boolean;
  print_type?(): string;
}

export interface UnknownType extends ConstantType {
  data_type: "unknown";
}

export type Expression =
  | CTE
  | Alias
  | ArithmeticOperation
  | And
  | Or
  | CompareOperation
  | Not
  | BetweenExpr
  | OrderExpr
  | ArrayAccess
  | Array
  | Dict
  | TupleAccess
  | Tuple
  | Lambda
  | Constant
  | Field
  | Placeholder
  | Call
  | ExprCall
  | JoinConstraint
  | JoinExpr
  | WindowFrameExpr
  | WindowExpr
  | WindowFunction
  | LimitByExpr
  | SelectQuery
  | SelectSetQuery
  | RatioExpr
  | SampleExpr
  | HogQLXTag;

export interface CTE extends Expr {
  expression_type: "cte";
  name: string;
  expr: Expression;
  cte_type: "column" | "subquery";
}

// Type system
export type TableOrSelectType =
  | BaseTableType
  | SelectSetQueryType
  | SelectQueryType
  | SelectQueryAliasType;

export interface FieldAliasType extends Type {
  alias: string;
  type: Type;
}

export interface BaseTableType extends Type {
  resolve_database_table?(context: HogQLContext): Table;
}

export interface TableType extends BaseTableType {
  table: Table;
}

export interface LazyJoinType extends BaseTableType {
  table_type: TableOrSelectType;
  field: string;
  lazy_join: LazyJoin;
}

export interface LazyTableType extends BaseTableType {
  table: LazyTable;
}

export interface TableAliasType extends BaseTableType {
  alias: string;
  table_type: TableType | LazyTableType;
}

export interface VirtualTableType extends BaseTableType {
  table_type: TableOrSelectType;
  field: string;
  virtual_table: VirtualTable;
}

export interface SelectQueryType extends Type {
  aliases: Record<string, FieldAliasType>;
  columns: Record<string, Type>;
  tables: Record<string, TableOrSelectType>;
  ctes: Record<string, CTE>;
  anonymous_tables: (SelectQueryType | SelectSetQueryType)[];
  parent?: SelectQueryType | SelectSetQueryType;
  is_lambda_type?: boolean;
}

export interface SelectSetQueryType extends Type {
  types: (SelectQueryType | SelectSetQueryType)[];
}

export interface SelectViewType extends BaseTableType {
  view_name: string;
  alias: string;
  select_query_type: SelectQueryType | SelectSetQueryType;
}

export interface SelectQueryAliasType extends Type {
  alias: string;
  select_query_type: SelectQueryType | SelectSetQueryType;
}

export interface IntegerType extends ConstantType {
  data_type: "int";
}

export interface DecimalType extends ConstantType {
  data_type: "unknown";
}

export interface FloatType extends ConstantType {
  data_type: "float";
}

export interface StringType extends ConstantType {
  data_type: "str";
}

export interface StringJSONType extends StringType {}

export interface StringArrayType extends StringType {}

export interface BooleanType extends ConstantType {
  data_type: "bool";
}

export interface DateType extends ConstantType {
  data_type: "date";
}

export interface DateTimeType extends ConstantType {
  data_type: "datetime";
}

export interface IntervalType extends ConstantType {
  data_type: "unknown";
}

export interface UUIDType extends ConstantType {
  data_type: "uuid";
}

export interface ArrayType extends ConstantType {
  data_type: "array";
  item_type: ConstantType;
}

export interface TupleType extends ConstantType {
  data_type: "tuple";
  item_types: ConstantType[];
  repeat?: boolean;
}

export interface CallType extends Type {
  name: string;
  arg_types: ConstantType[];
  param_types?: ConstantType[];
  return_type: ConstantType;
}

export interface AsteriskType extends Type {
  table_type: TableOrSelectType;
}

export interface FieldTraverserType extends Type {
  chain: (string | number)[];
  table_type: TableOrSelectType;
}

export interface ExpressionFieldType extends Type {
  name: string;
  expr: Expression;
  table_type: TableOrSelectType;
  isolate_scope?: boolean;
}

export interface FieldType extends Type {
  name: string;
  table_type: TableOrSelectType;
}

export interface UnresolvedFieldType extends Type {
  name: string;
}

export interface PropertyType extends Type {
  chain: (string | number)[];
  field_type: FieldType;
  joined_subquery?: SelectQueryAliasType;
  joined_subquery_field_name?: string;
}

export interface LambdaArgumentType extends Type {
  name: string;
}

// Enums
export enum ArithmeticOperationOp {
  Add = "+",
  Sub = "-",
  Mult = "*",
  Div = "/",
  Mod = "%",
}

export enum CompareOperationOp {
  Eq = "==",
  NotEq = "!=",
  Gt = ">",
  GtEq = ">=",
  Lt = "<",
  LtEq = "<=",
  Like = "like",
  ILike = "ilike",
  NotLike = "not like",
  NotILike = "not ilike",
  In = "in",
  GlobalIn = "global in",
  NotIn = "not in",
  GlobalNotIn = "global not in",
  InCohort = "in cohort",
  NotInCohort = "not in cohort",
  Regex = "=~",
  IRegex = "=~*",
  NotRegex = "!~",
  NotIRegex = "!~*",
}

export const NEGATED_COMPARE_OPS: CompareOperationOp[] = [
  CompareOperationOp.NotEq,
  CompareOperationOp.NotLike,
  CompareOperationOp.NotILike,
  CompareOperationOp.NotIn,
  CompareOperationOp.GlobalNotIn,
  CompareOperationOp.NotInCohort,
  CompareOperationOp.NotRegex,
  CompareOperationOp.NotIRegex,
];

export type SetOperator =
  | "UNION ALL"
  | "UNION DISTINCT"
  | "INTERSECT"
  | "INTERSECT DISTINCT"
  | "EXCEPT";

export type ParseResult = Expression | Declaration | string;

// Declaration and Statement types
export interface Declaration extends AST {}

export interface VariableAssignment extends Declaration {
  left: Expression;
  right: Expression;
}

export interface VariableDeclaration extends Declaration {
  name: string;
  expr?: Expression;
}

export interface Statement extends Declaration {}

export interface ExprStatement extends Statement {
  expr?: Expression;
}

export interface ReturnStatement extends Statement {
  expr?: Expression;
}

export interface ThrowStatement extends Statement {
  expr?: Expression;
}

export interface TryCatchStatement extends Statement {
  try_stmt: Statement;
  catches: [string | null, string | null, Statement][];
  finally_stmt?: Statement;
}

export interface IfStatement extends Statement {
  expr: Expression;
  then: Statement;
  else_?: Statement;
}

export interface WhileStatement extends Statement {
  expr: Expression;
  body: Statement;
}

export interface ForStatement extends Statement {
  initializer?: VariableDeclaration | VariableAssignment | Expression;
  condition?: Expression;
  increment?: VariableDeclaration;
  body: Statement;
}

export interface ForInStatement extends Statement {
  keyVar?: string;
  valueVar: string;
  expr: Expression;
  body: Statement;
}

export interface Function extends Statement {
  name: string;
  params: string[];
  body: Statement;
}

export interface Block extends Statement {
  declarations: Declaration[];
}

export interface Program extends AST {
  declarations: Declaration[];
}

// Expression types
export interface Alias extends Expr {
  expression_type: "alias";
  alias: string;
  expr: Expression;
  hidden?: boolean;
  from_asterisk?: boolean;
}

export interface ArithmeticOperation extends Expr {
  expression_type: "arithmetic_operation";
  left: Expression;
  right: Expression;
  op: ArithmeticOperationOp;
}

export interface And extends Expr {
  expression_type: "and";
  type?: ConstantType;
  exprs: Expression[];
}

export interface Or extends Expr {
  expression_type: "or";
  exprs: Expression[];
  type?: ConstantType;
}

export interface CompareOperation extends Expr {
  expression_type: "compare_operation";
  left: Expression;
  right: Expression;
  op: CompareOperationOp;
  type?: ConstantType;
}

export interface Not extends Expr {
  expression_type: "not";
  expr: Expression;
  type?: ConstantType;
}

export interface BetweenExpr extends Expr {
  expression_type: "between_expr";
  expr: Expression;
  low: Expression;
  high: Expression;
  negated?: boolean;
  type?: ConstantType;
}

export interface OrderExpr extends Expr {
  expression_type: "order_expr";
  expr: Expression;
  order?: "ASC" | "DESC";
}

export interface ArrayAccess extends Expr {
  expression_type: "array_access";
  array: Expression;
  property: Expression;
  nullish?: boolean;
}

export interface Array extends Expr {
  expression_type: "array";
  exprs: Expression[];
}

export interface Dict extends Expr {
  expression_type: "dict";
  items: [Expression, Expression][];
}

export interface TupleAccess extends Expr {
  expression_type: "tuple_access";
  tuple: Expression;
  index: number;
  nullish?: boolean;
}

export interface Tuple extends Expr {
  expression_type: "tuple";
  exprs: Expression[];
}

export interface Lambda extends Expr {
  expression_type: "lambda";
  args: string[];
  expr: Expression | Block;
}

export interface Constant extends Expr {
  expression_type: "constant";
  value: any;
}

export interface Field extends Expr {
  expression_type: "field";
  chain: (string | number)[];
  from_asterisk?: boolean;
}

export interface Placeholder extends Expr {
  expression_type: "placeholder";
  expr: Expression;
  // Computed properties
  chain?: (string | number)[] | null;
  field?: string | null;
}

export interface Call extends Expr {
  expression_type: "call";
  name: string;
  args: Expression[];
  params?: Expression[];
  distinct?: boolean;
}

export interface ExprCall extends Expr {
  expression_type: "expr_call";
  expr: Expression;
  args: Expression[];
}

export interface JoinConstraint extends Expr {
  expression_type: "join_constraint";
  expr: Expression;
  constraint_type: "ON" | "USING";
}

export interface JoinExpr extends Expr {
  expression_type: "join_expr";
  type?: TableOrSelectType;
  join_type?: string;
  table?: SelectQuery | SelectSetQuery | Placeholder | HogQLXTag | Field;
  table_args?: Expression[];
  alias?: string;
  table_final?: boolean;
  constraint?: JoinConstraint;
  next_join?: JoinExpr;
  sample?: SampleExpr;
}

export interface WindowFrameExpr extends Expr {
  expression_type: "window_frame_expr";
  frame_type?: "CURRENT ROW" | "PRECEDING" | "FOLLOWING";
  frame_value?: number;
}

export interface WindowExpr extends Expr {
  expression_type: "window_expr";
  partition_by?: Expression[];
  order_by?: OrderExpr[];
  frame_method?: "ROWS" | "RANGE";
  frame_start?: WindowFrameExpr;
  frame_end?: WindowFrameExpr;
}

export interface WindowFunction extends Expr {
  expression_type: "window_function";
  name: string;
  args?: Expression[];
  exprs?: Expression[];
  over_expr?: WindowExpr;
  over_identifier?: string;
}

export interface LimitByExpr extends Expr {
  expression_type: "limit_by_expr";
  n: Expression;
  exprs: Expression[];
  offset_value?: Expression;
}

export interface SelectQuery extends Expr {
  expression_type: "select_query";
  type?: SelectQueryType;
  ctes?: Record<string, CTE>;
  select: Expression[];
  distinct?: boolean;
  select_from?: JoinExpr;
  array_join_op?: string;
  array_join_list?: Expression[];
  window_exprs?: Record<string, WindowExpr>;
  where?: Expression;
  prewhere?: Expression;
  having?: Expression;
  group_by?: Expression[];
  order_by?: OrderExpr[];
  limit?: Expression;
  limit_by?: LimitByExpr;
  limit_with_ties?: boolean;
  offset?: Expression;
  settings?: HogQLQuerySettings;
  view_name?: string;
}

export interface SelectSetNode extends AST {
  select_query: SelectQuery | SelectSetQuery;
  set_operator: SetOperator;
}

export interface SelectSetQuery extends Expr {
  expression_type: "select_set_query";
  type?: SelectSetQueryType;
  initial_select_query: SelectQuery | SelectSetQuery;
  subsequent_select_queries: SelectSetNode[];
  // Equivalent to select_queries() method
  select_queries?(): (SelectQuery | SelectSetQuery)[];
}

// Add static method equivalent for SelectSetQuery.create_from_queries()
export namespace SelectSetQuery {
  export function createFromQueries(
    queries: (SelectQuery | SelectSetQuery)[],
    set_operator: SetOperator
  ): SelectQuery | SelectSetQuery {
    return createSelectSetQueryFromQueries(queries, set_operator);
  }
}

export interface RatioExpr extends Expr {
  expression_type: "ratio_expr";
  left: Constant;
  right?: Constant;
}

export interface SampleExpr extends Expr {
  expression_type: "sample_expr";
  sample_value: RatioExpr;
  offset_value?: RatioExpr;
}

export interface HogQLXAttribute extends AST {
  name: string;
  value: any;
}

export interface HogQLXTag extends Expr {
  expression_type: "hogqlx_tag";
  kind: string;
  attributes: HogQLXAttribute[];
  // Equivalent to to_dict() method
  to_dict?(): Record<string, any>;
}

// Helper function to create empty SelectQuery (equivalent to SelectQuery.empty())
export function createEmptySelectQuery(columns?: Record<string, FieldOrTable>): SelectQuery {
  if (!columns) {
    columns = { _: { name: "_" } as UnknownDatabaseField };
  }

  return {
    expression_type: "select_query",
    select: Object.entries(columns).map(([column, field]) => ({
      expression_type: "alias" as const,
      alias: column,
      expr: {
        expression_type: "constant",
        value: (field as DatabaseField).default_value?.() ?? null,
      } as Constant,
    })),
    where: { expression_type: "constant", value: false } as Constant,
  };
}

// Add static method equivalent for SelectQuery.empty()
export namespace SelectQuery {
  export function empty(columns?: Record<string, FieldOrTable>): SelectQuery {
    return createEmptySelectQuery(columns);
  }
}

// Helper function for SelectSetQuery.select_queries()
export function selectQueries(query: SelectSetQuery): (SelectQuery | SelectSetQuery)[] {
  return [
    query.initial_select_query,
    ...query.subsequent_select_queries.map((node) => node.select_query),
  ];
}

// Helper function to create SelectSetQuery from multiple queries
export function createSelectSetQueryFromQueries(
  queries: (SelectQuery | SelectSetQuery)[],
  set_operator: SetOperator
): SelectQuery | SelectSetQuery {
  if (queries.length === 0) {
    throw new Error("Cannot create a SelectSetQuery from an empty list of queries");
  } else if (queries.length === 1) {
    return queries[0];
  }

  return {
    initial_select_query: queries[0],
    subsequent_select_queries: queries.slice(1).map((query) => ({
      select_query: query,
      set_operator,
    })) as SelectSetNode[],
  } as SelectSetQuery;
}
