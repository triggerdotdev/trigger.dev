import {
  parseTSQLSelect,
  SyntaxError as TSQLSyntaxError,
  type Field,
  type JoinExpr,
  type SelectQuery,
  type SelectSetQuery,
} from "@internal/tsql";

/**
 * Extract every known table a TRQL query reads — the FROM table, every JOIN in
 * the chain, and any subqueries — for per-table JWT-scope authorization.
 *
 * `allowedTableNames` is the set of recognised table names (matched
 * case-insensitively); anything not in it is ignored. Injected so this stays
 * dependency-free (the caller derives it from the query schemas).
 *
 * Returns `null` when the query can't be parsed; callers MUST treat `null` as
 * deny-by-default.
 */
export function detectQueryTables(query: string, allowedTableNames: Set<string>): string[] | null {
  let ast: SelectQuery | SelectSetQuery;
  try {
    ast = parseTSQLSelect(query);
  } catch (err) {
    if (err instanceof TSQLSyntaxError) return null;
    throw err;
  }

  const allowed = new Map(Array.from(allowedTableNames, (n) => [n.toLowerCase(), n]));
  const seen = new Set<string>();
  const scanned = new WeakSet<object>();

  function visitSelect(q: SelectQuery): void {
    // CTE bodies: `WITH r AS (SELECT ... FROM <table>) ...` — the table is
    // read by the CTE even when the outer query only references the CTE alias.
    if (q.ctes) {
      for (const cte of Object.values(q.ctes)) {
        scanForSubqueries(cte.expr);
      }
    }
    // FROM / JOIN chain (tables + FROM-position subqueries).
    if (q.select_from) visitJoin(q.select_from);
    // Subqueries anywhere else (WHERE, SELECT list, GROUP BY, ORDER BY, etc.)
    // can each embed a SELECT that reads a real table, e.g.
    // `WHERE id IN (SELECT … FROM runs)`.
    scanForSubqueries(q.select);
    scanForSubqueries(q.where);
    scanForSubqueries(q.prewhere);
    scanForSubqueries(q.having);
    scanForSubqueries(q.group_by);
    scanForSubqueries(q.array_join_list);
    scanForSubqueries(q.order_by);
    scanForSubqueries(q.limit);
    scanForSubqueries(q.offset);
    scanForSubqueries(q.limit_by);
    scanForSubqueries(q.window_exprs);
  }
  // Shape-agnostic walk of an expression subtree: descends every nested
  // object/array and hands any embedded SELECT to the query visitors, so a new
  // node shape can't silently reintroduce a detection gap. The WeakSet guards
  // against back-reference cycles the AST might carry.
  function scanForSubqueries(node: unknown): void {
    if (node === null || typeof node !== "object") return;
    if (scanned.has(node)) return;
    scanned.add(node);
    if (Array.isArray(node)) {
      for (const item of node) scanForSubqueries(item);
      return;
    }
    const expressionType = (node as { expression_type?: string }).expression_type;
    if (expressionType === "select_query") {
      visitSelect(node as SelectQuery);
      return;
    }
    if (expressionType === "select_set_query") {
      visitSelectSet(node as SelectSetQuery);
      return;
    }
    for (const value of Object.values(node)) scanForSubqueries(value);
  }
  function visitSelectSet(q: SelectSetQuery): void {
    visitAny(q.initial_select_query);
    for (const node of q.subsequent_select_queries ?? []) {
      visitAny(node.select_query);
    }
  }
  function visitAny(q: SelectQuery | SelectSetQuery): void {
    if (q.expression_type === "select_query") visitSelect(q);
    else visitSelectSet(q);
  }
  function visitJoin(node: JoinExpr): void {
    const tableExpr = node.table;
    if (tableExpr) {
      if ((tableExpr as Field).expression_type === "field") {
        const name = (tableExpr as Field).chain[0];
        const canonicalName =
          typeof name === "string" ? allowed.get(name.toLowerCase()) : undefined;
        if (canonicalName) seen.add(canonicalName);
      } else if ((tableExpr as SelectQuery).expression_type === "select_query") {
        visitSelect(tableExpr as SelectQuery);
      } else if ((tableExpr as SelectSetQuery).expression_type === "select_set_query") {
        visitSelectSet(tableExpr as SelectSetQuery);
      }
    }
    if (node.next_join) visitJoin(node.next_join);
  }

  if (ast.expression_type === "select_set_query") visitSelectSet(ast);
  else visitSelect(ast);

  return Array.from(seen);
}
