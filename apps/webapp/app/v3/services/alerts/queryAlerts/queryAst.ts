import {
  findTSQLAggregation,
  type Alias,
  type Call,
  type Expression,
  type Field,
  type JoinExpr,
  type SelectQuery,
  type SelectSetQuery,
} from "@internal/tsql";

export type AnyQuery = SelectQuery | SelectSetQuery;

export type FromEntry =
  | { kind: "table"; name: string; table: string; ref: JoinExpr }
  | { kind: "query"; name?: string; query: AnyQuery; ref: JoinExpr };

function isSelectQuery(node: unknown): node is SelectQuery {
  return (node as { expression_type?: string } | null)?.expression_type === "select_query";
}

function isSelectSetQuery(node: unknown): node is SelectSetQuery {
  return (node as { expression_type?: string } | null)?.expression_type === "select_set_query";
}

export function isField(node: unknown): node is Field {
  return (node as { expression_type?: string } | null)?.expression_type === "field";
}

export function unwrapAlias(expr: Expression): Expression {
  return expr.expression_type === "alias" ? (expr as Alias).expr : expr;
}

export function branchesOf(query: AnyQuery): SelectQuery[] {
  if (isSelectQuery(query)) return [query];
  return [
    ...branchesOf(query.initial_select_query),
    ...(query.subsequent_select_queries ?? []).flatMap((n) => branchesOf(n.select_query)),
  ];
}

export function fromEntries(query: SelectQuery): FromEntry[] {
  const entries: FromEntry[] = [];
  for (let join = query.select_from; join; join = join.next_join) {
    const table = join.table;
    if (isField(table)) {
      const name = String(table.chain[0]).toLowerCase();
      entries.push({ kind: "table", name: join.alias ?? name, table: name, ref: join });
    } else if (isSelectQuery(table) || isSelectSetQuery(table)) {
      entries.push({ kind: "query", name: join.alias, query: table, ref: join });
    }
  }
  return entries;
}

/** Every SELECT in the tree: outer query, UNION branches, FROM/JOIN/IN subqueries, CTE bodies. */
export function allSelects(root: AnyQuery): SelectQuery[] {
  const found: SelectQuery[] = [];
  const seen = new WeakSet<object>();
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (isSelectQuery(node)) found.push(node);
    for (const value of Object.values(node)) visit(value);
  };
  visit(root);
  return found;
}

/** Walks an expression without descending into nested SELECTs. */
function walkExpr(node: unknown, visit: (node: Expression) => boolean | void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkExpr(item, visit);
    return;
  }
  if (isSelectQuery(node) || isSelectSetQuery(node)) return;
  if (typeof (node as { expression_type?: unknown }).expression_type === "string") {
    if (visit(node as Expression) === false) return;
  }
  for (const value of Object.values(node)) walkExpr(value, visit);
}

function isAggregateCall(node: Expression): node is Call {
  return node.expression_type === "call" && !!findTSQLAggregation((node as Call).name)?.aggregate;
}

export function containsAggregate(expr: Expression): boolean {
  let found = false;
  walkExpr(expr, (node) => {
    if (node.expression_type === "window_function") return false;
    if (isAggregateCall(node)) found = true;
    return !found;
  });
  return found;
}

/** A field read outside any aggregate call. */
export function hasFreeField(expr: Expression): boolean {
  let found = false;
  walkExpr(expr, (node) => {
    if (isAggregateCall(node) || node.expression_type === "window_function") return false;
    if (node.expression_type === "field") found = true;
    return !found;
  });
  return found;
}

export function containsWindowFunction(expr: Expression): boolean {
  let found = false;
  walkExpr(expr, (node) => {
    if (node.expression_type === "window_function") found = true;
    return !found;
  });
  return found;
}

export function fieldsIn(expr: unknown): Field[] {
  const fields: Field[] = [];
  walkExpr(expr, (node) => {
    if (isField(node)) fields.push(node);
  });
  return fields;
}

export function callsIn(expr: unknown): Call[] {
  const calls: Call[] = [];
  walkExpr(expr, (node) => {
    if (node.expression_type === "call") calls.push(node as Call);
  });
  return calls;
}

export function lastName(field: Field): string {
  return String(field.chain[field.chain.length - 1]);
}

export function isStar(expr: Expression): boolean {
  const inner = unwrapAlias(expr);
  return isField(inner) && inner.chain.some((part) => part === "*");
}

/** The name a select item gets in the result, when it is derivable from the AST. */
export function itemName(expr: Expression): string | undefined {
  if (expr.expression_type === "alias") return (expr as Alias).alias;
  if (isField(expr)) return lastName(expr);
  return undefined;
}
