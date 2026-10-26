import { getQuerySource, QUERY_SOURCES, type QuerySource } from "@internal/alert-contracts";
import type { Expression, Field, JoinExpr, SelectQuery, TableSchema } from "@internal/tsql";
import {
  allSelects,
  branchesOf,
  containsAggregate,
  containsWindowFunction,
  fieldsIn,
  fromEntries,
  isField,
  isStar,
  itemName,
  lastName,
  unwrapAlias,
  type AnyQuery,
  type FromEntry,
} from "./queryAst";

type Lineage = { table: string; column: string; ref: JoinExpr; nullable: boolean };
type Resolved =
  | { ok: true; lineages: Lineage[] }
  | { ok: false; reason: "derived" | "derived_id" | "aggregated" | "unresolved" };

export type MatchResult =
  | { ok: true; source: QuerySource; idIndex: number; eventIndex: number }
  | { ok: false; code: string; message: string };

const MATCH_SOURCES = Object.values(QUERY_SOURCES).filter(
  (s) => s.stableId && s.timeColumns.match && s.modes.includes("match")
);
const STABLE_IDS = new Set(MATCH_SOURCES.map((s) => s.stableId!));
const ID_HINT = MATCH_SOURCES.map((s) => `${s.stableId} from ${s.table}`).join(" or ");

function isRowsQuery(query: SelectQuery): boolean {
  return (
    !query.group_by?.length &&
    !query.distinct &&
    !query.array_join_list?.length &&
    !query.select.some((item) => containsAggregate(item) || containsWindowFunction(item))
  );
}

function outputIndex(query: AnyQuery, name: string): number {
  const select = branchesOf(query)[0]!.select;
  const matches = select.flatMap((item, i) => (itemName(item) === name ? [i] : []));
  return matches.length === 1 ? matches[0]! : -1;
}

// LEFT/FULL null the joined side; RIGHT/FULL null everything before it.
function nullableRefs(entries: FromEntry[]): Set<JoinExpr> {
  const nullable = new Set<JoinExpr>();
  entries.forEach((entry, i) => {
    const type = entry.ref.join_type ?? "";
    if (i > 0 && /LEFT|FULL/i.test(type)) nullable.add(entry.ref);
    if (/RIGHT|FULL/i.test(type)) entries.slice(0, i).forEach((e) => nullable.add(e.ref));
  });
  return nullable;
}

function entryHas(entry: FromEntry, column: string, schemas: Map<string, TableSchema>): boolean {
  if (entry.kind === "table") return !!schemas.get(entry.table)?.columns[column];
  return outputIndex(entry.query, column) >= 0;
}

function resolveField(
  query: SelectQuery,
  field: Field,
  schemas: Map<string, TableSchema>
): Resolved {
  const chain = field.chain.map(String);
  const entries = fromEntries(query);
  let entry: FromEntry | undefined;
  const column = chain[chain.length - 1]!;
  if (chain.length === 2) {
    entry = entries.find((e) => e.name === chain[0]);
  } else if (chain.length === 1) {
    const candidates = entries.filter((e) => entryHas(e, column, schemas));
    entry = candidates.length === 1 ? candidates[0] : undefined;
  }
  if (!entry) return { ok: false, reason: "unresolved" };
  const nullable = nullableRefs(entries).has(entry.ref);
  if (entry.kind === "table") {
    return { ok: true, lineages: [{ table: entry.table, column, ref: entry.ref, nullable }] };
  }
  const index = outputIndex(entry.query, column);
  if (index < 0) return { ok: false, reason: "unresolved" };
  const resolved = resolveOutput(entry.query, index, schemas);
  if (!resolved.ok || !nullable) return resolved;
  return { ok: true, lineages: resolved.lineages.map((l) => ({ ...l, nullable: true })) };
}

function resolveItem(
  query: SelectQuery,
  item: Expression | undefined,
  schemas: Map<string, TableSchema>
): Resolved {
  if (!item || isStar(item)) return { ok: false, reason: "unresolved" };
  if (!isRowsQuery(query)) return { ok: false, reason: "aggregated" };
  const inner = unwrapAlias(item);
  if (isField(inner)) return resolveField(query, inner, schemas);
  const readsId = fieldsIn(inner).some((f) => STABLE_IDS.has(lastName(f)));
  return { ok: false, reason: readsId ? "derived_id" : "derived" };
}

function resolveOutput(
  query: AnyQuery,
  index: number,
  schemas: Map<string, TableSchema>
): Resolved {
  const lineages: Lineage[] = [];
  for (const branch of branchesOf(query)) {
    const resolved = resolveItem(branch, branch.select[index], schemas);
    if (!resolved.ok) return resolved;
    lineages.push(...resolved.lineages);
  }
  return { ok: true, lineages };
}

function idSourceOf(lineage: Lineage): QuerySource | undefined {
  const source = getQuerySource(lineage.table);
  return source && MATCH_SOURCES.includes(source) && source.stableId === lineage.column
    ? source
    : undefined;
}

function fail(code: string, message: string): MatchResult {
  return { ok: false, code, message };
}

export function analyzeMatch(root: AnyQuery, schemas: Map<string, TableSchema>): MatchResult {
  const branches = branchesOf(root);
  for (const branch of branches) {
    if (branch.distinct) {
      return fail(
        "distinct",
        "New-row alerts need one result row per source row; remove DISTINCT."
      );
    }
    if (branch.array_join_list?.length) {
      return fail(
        "array_join",
        "New-row alerts can't follow rows through ARRAY JOIN; remove it from the outer query."
      );
    }
  }

  const width = branches[0]!.select.length;
  const resolved = Array.from({ length: width }, (_, i) => resolveOutput(root, i, schemas));
  const reasons = new Set(resolved.flatMap((r) => (r.ok ? [] : [r.reason])));
  let disagree = false;
  const idIndex = resolved.findIndex((r) => {
    if (!r.ok) return false;
    const sources = r.lineages.map(idSourceOf);
    if (sources.every((s) => s && s === sources[0])) return true;
    if (sources.some(Boolean)) disagree = true;
    return false;
  });

  if (idIndex < 0) {
    if (disagree) {
      return fail(
        "union_branches_disagree",
        "Every UNION branch must select the same row id from the same source in the same position."
      );
    }
    if (reasons.has("derived_id")) {
      return fail(
        "derived_id",
        `Select the row id as-is (${ID_HINT}); a computed id can't identify new rows.`
      );
    }
    if (reasons.has("aggregated")) {
      return fail(
        "aggregated",
        "New-row alerts can't follow rows through GROUP BY, aggregates or DISTINCT."
      );
    }
    return fail("no_row_id", `Select a row id column (${ID_HINT}) to alert on new rows.`);
  }

  const idLineages = (resolved[idIndex] as Extract<Resolved, { ok: true }>).lineages;
  const source = idSourceOf(idLineages[0]!)!;
  if (idLineages.some((l) => l.nullable)) {
    return fail(
      "outer_join_id",
      `Read ${source.stableId} from the side of the JOIN that always has rows; an outer-joined ${source.table} can't identify new rows.`
    );
  }
  const idRefs = new Set(idLineages.map((l) => l.ref));
  const eventIndex = resolved.findIndex(
    (r) =>
      r.ok &&
      r.lineages.length === idLineages.length &&
      r.lineages.every((l) => idRefs.has(l.ref) && l.column === source.timeColumns.match)
  );
  if (eventIndex < 0) {
    return fail(
      "no_event_column",
      `Also select ${source.timeColumns.match} from the same ${source.table} reference as ${source.stableId}.`
    );
  }

  const sourceRefs = allSelects(root)
    .flatMap(fromEntries)
    .filter((e) => e.kind === "table" && e.table === source.table);
  if (sourceRefs.length !== idRefs.size) {
    return fail(
      "id_source_repeated",
      `${source.table} must appear only once per branch for new-row alerts; remove the extra ${source.table} reference.`
    );
  }

  return { ok: true, source, idIndex, eventIndex };
}
