import type { Alias, Field, SelectQuery } from "@internal/tsql";
import {
  branchesOf,
  callsIn,
  fieldsIn,
  fromEntries,
  isStar,
  itemName,
  unwrapAlias,
  type FromEntry,
} from "./queryAst";

const TIME_BUCKET_CALL = /^(timebucket|tostartof|todate|totime|tounixtimestamp)/i;

export type TimeRule = {
  isTimeColumn: (table: string, column: string) => boolean;
  buckets: boolean;
  onUnverifiable?: () => void;
};

/** True when the expression reads a time column, directly, via a SELECT alias, or via a FROM-subquery output. */
export function touchesTime(query: SelectQuery, expr: unknown, rule: TimeRule): boolean {
  return touches(query, expr, rule, new Set());
}

function touches(query: SelectQuery, expr: unknown, rule: TimeRule, seen: Set<object>): boolean {
  if (rule.buckets && callsIn(expr).some((c) => TIME_BUCKET_CALL.test(c.name))) return true;
  return fieldsIn(expr).some((field) => fieldTouches(query, field, rule, seen));
}

function fieldTouches(
  query: SelectQuery,
  field: Field,
  rule: TimeRule,
  seen: Set<object>
): boolean {
  const chain = field.chain.map(String);
  const column = chain[chain.length - 1]!;
  if (chain.length === 1) {
    const aliased = query.select.find(
      (item): item is Alias => item.expression_type === "alias" && (item as Alias).alias === column
    );
    if (aliased && !seen.has(aliased)) {
      seen.add(aliased);
      if (touches(query, aliased.expr, rule, seen)) return true;
    }
  }
  const entries = fromEntries(query);
  const candidates = chain.length === 1 ? entries : entries.filter((e) => e.name === chain[0]);
  return candidates.some((entry) => entryTouches(entry, column, rule, seen));
}

function entryTouches(entry: FromEntry, column: string, rule: TimeRule, seen: Set<object>) {
  if (entry.kind === "table") return rule.isTimeColumn(entry.table, column);
  const branches = branchesOf(entry.query);
  // UNION columns line up by position, which a star hides.
  if (branches.length > 1 && branches.some((b) => b.select.some(isStar))) {
    rule.onUnverifiable?.();
    return true;
  }
  const indexes = branches[0]!.select.flatMap((item, i) => (itemName(item) === column ? [i] : []));
  const starField = { expression_type: "field", chain: [column] } as Field;
  return branches.some(
    (branch) =>
      (branch.select.some(isStar) && fieldTouches(branch, starField, rule, seen)) ||
      indexes.some((i) => {
        const item = branch.select[i];
        if (!item || seen.has(item)) return false;
        seen.add(item);
        return touches(branch, unwrapAlias(item), rule, seen);
      })
  );
}
