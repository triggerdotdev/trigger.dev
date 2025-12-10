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

export interface CTE extends Expr {
  name: string;
  expr: Expr;
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
  expr: Expr;
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

// Declaration and Statement types
export interface Declaration extends AST {}

export interface VariableAssignment extends Declaration {
  left: Expr;
  right: Expr;
}

export interface VariableDeclaration extends Declaration {
  name: string;
  expr?: Expr;
}

export interface Statement extends Declaration {}

export interface ExprStatement extends Statement {
  expr?: Expr;
}

export interface ReturnStatement extends Statement {
  expr?: Expr;
}

export interface ThrowStatement extends Statement {
  expr: Expr;
}

export interface TryCatchStatement extends Statement {
  try_stmt: Statement;
  catches: [string | null, string | null, Statement][];
  finally_stmt?: Statement;
}

export interface IfStatement extends Statement {
  expr: Expr;
  then: Statement;
  else_?: Statement;
}

export interface WhileStatement extends Statement {
  expr: Expr;
  body: Statement;
}

export interface ForStatement extends Statement {
  initializer?: VariableDeclaration | VariableAssignment | Expr;
  condition?: Expr;
  increment?: Expr;
  body: Statement;
}

export interface ForInStatement extends Statement {
  keyVar?: string;
  valueVar: string;
  expr: Expr;
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
  alias: string;
  expr: Expr;
  hidden?: boolean;
  from_asterisk?: boolean;
}

export interface ArithmeticOperation extends Expr {
  left: Expr;
  right: Expr;
  op: ArithmeticOperationOp;
}

export interface And extends Expr {
  type?: ConstantType;
  exprs: Expr[];
}

export interface Or extends Expr {
  exprs: Expr[];
  type?: ConstantType;
}

export interface CompareOperation extends Expr {
  left: Expr;
  right: Expr;
  op: CompareOperationOp;
  type?: ConstantType;
}

export interface Not extends Expr {
  expr: Expr;
  type?: ConstantType;
}

export interface BetweenExpr extends Expr {
  expr: Expr;
  low: Expr;
  high: Expr;
  negated?: boolean;
  type?: ConstantType;
}

export interface OrderExpr extends Expr {
  expr: Expr;
  order?: "ASC" | "DESC";
}

export interface ArrayAccess extends Expr {
  array: Expr;
  property: Expr;
  nullish?: boolean;
}

export interface Array extends Expr {
  exprs: Expr[];
}

export interface Dict extends Expr {
  items: [Expr, Expr][];
}

export interface TupleAccess extends Expr {
  tuple: Expr;
  index: number;
  nullish?: boolean;
}

export interface Tuple extends Expr {
  exprs: Expr[];
}

export interface Lambda extends Expr {
  args: string[];
  expr: Expr | Block;
}

export interface Constant extends Expr {
  value: any;
}

export interface Field extends Expr {
  chain: (string | number)[];
  from_asterisk?: boolean;
}

export interface Placeholder extends Expr {
  expr: Expr;
  // Computed properties
  chain?: (string | number)[] | null;
  field?: string | null;
}

export interface Call extends Expr {
  name: string;
  args: Expr[];
  params?: Expr[];
  distinct?: boolean;
}

export interface ExprCall extends Expr {
  expr: Expr;
  args: Expr[];
}

export interface JoinConstraint extends Expr {
  expr: Expr;
  constraint_type: "ON" | "USING";
}

export interface JoinExpr extends Expr {
  type?: TableOrSelectType;
  join_type?: string;
  table?: SelectQuery | SelectSetQuery | Placeholder | HogQLXTag | Field;
  table_args?: Expr[];
  alias?: string;
  table_final?: boolean;
  constraint?: JoinConstraint;
  next_join?: JoinExpr;
  sample?: SampleExpr;
}

export interface WindowFrameExpr extends Expr {
  frame_type?: "CURRENT ROW" | "PRECEDING" | "FOLLOWING";
  frame_value?: number;
}

export interface WindowExpr extends Expr {
  partition_by?: Expr[];
  order_by?: OrderExpr[];
  frame_method?: "ROWS" | "RANGE";
  frame_start?: WindowFrameExpr;
  frame_end?: WindowFrameExpr;
}

export interface WindowFunction extends Expr {
  name: string;
  args?: Expr[];
  exprs?: Expr[];
  over_expr?: WindowExpr;
  over_identifier?: string;
}

export interface LimitByExpr extends Expr {
  n: Expr;
  exprs: Expr[];
  offset_value?: Expr;
}

export interface SelectQuery extends Expr {
  type?: SelectQueryType;
  ctes?: Record<string, CTE>;
  select: Expr[];
  distinct?: boolean;
  select_from?: JoinExpr;
  array_join_op?: string;
  array_join_list?: Expr[];
  window_exprs?: Record<string, WindowExpr>;
  where?: Expr;
  prewhere?: Expr;
  having?: Expr;
  group_by?: Expr[];
  order_by?: OrderExpr[];
  limit?: Expr;
  limit_by?: LimitByExpr;
  limit_with_ties?: boolean;
  offset?: Expr;
  settings?: HogQLQuerySettings;
  view_name?: string;
}

export interface SelectSetNode extends AST {
  select_query: SelectQuery | SelectSetQuery;
  set_operator: SetOperator;
}

export interface SelectSetQuery extends Expr {
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
  left: Constant;
  right?: Constant;
}

export interface SampleExpr extends Expr {
  sample_value: RatioExpr;
  offset_value?: RatioExpr;
}

export interface HogQLXAttribute extends AST {
  name: string;
  value: any;
}

export interface HogQLXTag extends Expr {
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
    select: Object.entries(columns).map(([column, field]) => ({
      alias: column,
      expr: { value: (field as DatabaseField).default_value?.() ?? null } as Constant,
    })) as Alias[],
    where: { value: false } as Constant,
  } as SelectQuery;
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
