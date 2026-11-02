import {
  getQuerySource,
  minCadenceForTables,
  modesForTables,
  querySignalSchema,
  type QueryMode,
  type QuerySignal,
} from "@internal/alert-contracts";
import {
  compileTSQL,
  ExposedTSQLError,
  measureTSQLNesting,
  parseTSQLSelect,
  type Alias,
  type Call,
  type Expression,
  type Field,
  type OutputColumnMetadata,
  type SelectQuery,
  type TableSchema,
} from "@internal/tsql";
import { z } from "zod";
import { detectQueryTables } from "~/v3/detectQueryTables";
import { analyzeMatch } from "./matchLineage";
import { touchesTime } from "./timeLineage";
import {
  allSelects,
  branchesOf,
  containsAggregate,
  containsWindowFunction,
  fieldsIn,
  fromEntries,
  hasFreeField,
  isStar,
  isField,
  itemName,
  lastName,
  unwrapAlias,
  type AnyQuery,
} from "./queryAst";

export const QUERY_ALERT_ANALYZER_VERSION = 1;

const queryModeSchema = z.enum(["threshold", "absence", "match"]);

const measureSchema = z.object({
  column: z.string(),
  type: z.string(),
  format: z.string().optional(),
  countLike: z.boolean(),
});

export const queryAlertAnalysisSchema = z.object({
  ok: z.boolean(),
  analyzerVersion: z.literal(QUERY_ALERT_ANALYZER_VERSION),
  sources: z.array(z.object({ sourceId: z.string(), alias: z.string().optional() })),
  columns: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      role: z.enum(["measure", "group", "rowId", "time", "other"]),
    })
  ),
  modes: z.array(
    z.discriminatedUnion("mode", [
      z.object({
        mode: z.literal("threshold"),
        shape: z.enum(["scalar", "grouped"]),
        measures: z.array(measureSchema),
        groupColumns: z.array(z.string()),
        absenceAllowed: z.boolean(),
      }),
      z.object({
        mode: z.literal("match"),
        sourceId: z.string(),
        rowIdColumn: z.string(),
        eventColumn: z.string(),
      }),
    ])
  ),
  unsupported: z.array(z.object({ mode: queryModeSchema, code: z.string(), message: z.string() })),
  errors: z.array(z.object({ code: z.string(), message: z.string() })),
  limits: z.object({
    minCadenceSec: z.number(),
    maxWindowSec: z.number(),
    maxGroups: z.number(),
    maxMatchRowsPerEval: z.number(),
    detailRows: z.number(),
  }),
  suggestedName: z.string(),
});

export type QueryAlertAnalysis = z.infer<typeof queryAlertAnalysisSchema>;
type ThresholdMode = Extract<QueryAlertAnalysis["modes"][number], { mode: "threshold" }>;
type MatchMode = Extract<QueryAlertAnalysis["modes"][number], { mode: "match" }>;
type Issue = { code: string; message: string };

export type AnalyzeQueryContext = {
  tableSchemas: TableSchema[];
  flags: Record<string, boolean | undefined>;
};

export type QueryAlertChoice = { mode: QueryMode; measure?: string };

const LIMITS = {
  maxWindowSec: 86_400,
  maxGroups: 500,
  maxMatchRowsPerEval: 200,
  detailRows: 10,
};

// Columns whose sum() is still an event count, so "drops to 0" means "nothing happened".
const COUNT_COLUMNS: Record<string, string[]> = { error_occurrences: ["count"] };

const NUMERIC_TYPE = /^(Nullable\()?(U?Int\d+|Float\d+|Decimal)/;
const TIME_TYPE = /^(Nullable\()?(DateTime|Date)/;

const QUERY_LIMITS = {
  maxDepth: 12,
  cost: 80,
  tokens: 400,
  dotRun: 8,
  quotes: 50,
  operators: 16,
  weight: 1200,
};

const VALIDATION_TENANT = {
  organization_id: { op: "eq" as const, value: "query-alert-analysis" },
  project_id: { op: "eq" as const, value: "query-alert-analysis" },
  environment_id: { op: "eq" as const, value: "query-alert-analysis" },
};

export function analyzeQueryForAlert(query: string, ctx: AnalyzeQueryContext): QueryAlertAnalysis {
  const errors: Issue[] = [];
  const unsupported: QueryAlertAnalysis["unsupported"] = [];
  const result = (
    partial: Partial<QueryAlertAnalysis> & { tables?: string[] } = {}
  ): QueryAlertAnalysis => {
    const { tables = [], ...rest } = partial;
    const modes = errors.length ? [] : (rest.modes ?? []);
    return {
      ok: errors.length === 0 && modes.length > 0,
      analyzerVersion: QUERY_ALERT_ANALYZER_VERSION,
      sources: rest.sources ?? [],
      columns: rest.columns ?? [],
      modes,
      unsupported,
      errors,
      limits: { minCadenceSec: minCadenceForTables(tables) ?? 0, ...LIMITS },
      suggestedName: rest.suggestedName ?? fallbackName(query),
    };
  };

  if (query.includes("{{")) {
    errors.push({
      code: "placeholder",
      message: "Query alerts can't use {{…}} variables; replace them with fixed values.",
    });
    return result();
  }

  const nesting = measureTSQLNesting(query, QUERY_LIMITS);
  const tooComplex =
    nesting.maxDepth > QUERY_LIMITS.maxDepth
      ? { code: "too_deeply_nested", message: "Query is too deeply nested" }
      : (Object.keys(QUERY_LIMITS) as (keyof typeof QUERY_LIMITS)[]).some(
            (key) => nesting[key] > QUERY_LIMITS[key]
          )
        ? { code: "too_complex", message: "Query is too complex to watch" }
        : undefined;
  if (tooComplex) {
    errors.push(tooComplex);
    for (const mode of queryModeSchema.options) unsupported.push({ mode, ...tooComplex });
    return result();
  }

  let root: AnyQuery;
  try {
    root = parseTSQLSelect(query);
  } catch (error) {
    errors.push({ code: "parse_error", message: parseErrorMessage(error) });
    return result();
  }

  const schemas = new Map(ctx.tableSchemas.map((s) => [s.name.toLowerCase(), s]));
  const selects = allSelects(root);
  const tables = detectQueryTables(query, new Set(schemas.keys()), root) ?? [];
  const sources = sourceRefs(selects, tables);

  if (selects.some((s) => s.ctes && Object.keys(s.ctes).length > 0)) {
    for (const mode of queryModeSchema.options) {
      unsupported.push({ mode, code: "cte", message: "TRQL does not support CTEs yet." });
    }
    return result({ sources, tables });
  }

  checkTables(selects, tables, schemas, ctx.flags, errors);
  if (errors.length) return result({ sources, tables });

  let compiled: OutputColumnMetadata[];
  try {
    compiled = compileTSQL(
      query,
      {
        tableSchema: ctx.tableSchemas,
        enforcedWhereClause: VALIDATION_TENANT,
        timeRange: { from: new Date(0), to: new Date(LIMITS.maxWindowSec * 1000) },
      },
      root
    ).columns;
  } catch (error) {
    const message =
      error instanceof ExposedTSQLError ? error.message : "The query is not valid TRQL.";
    errors.push({ code: "invalid_query", message });
    return result({ sources, tables });
  }

  checkLimits(selects, errors);
  checkWindowColumns(selects, tables, errors);
  const names = compiled.map((c) => c.name);
  if (new Set(names).size !== names.length) {
    errors.push({
      code: "duplicate_columns",
      message: "Give every column a unique name with AS so the alert can tell them apart.",
    });
  }
  if (errors.length) return result({ sources, tables });

  const shape = analyzeShape(root, compiled, schemas, tables, unsupported);
  const allowed = modesForTables(tables);
  const modes: QueryAlertAnalysis["modes"] = [];
  const sourceList = tables.join(", ");

  if (shape.threshold) {
    if (allowed.includes("threshold")) {
      const absenceAllowed =
        shape.threshold.shape === "scalar" &&
        allowed.includes("absence") &&
        shape.threshold.measures.some((m) => m.countLike);
      if (!absenceAllowed) {
        unsupported.push({
          mode: "absence",
          code: allowed.includes("absence") ? "not_count_like" : "source_mode",
          message: allowed.includes("absence")
            ? '"No results" alerts need a single count() measure without GROUP BY or HAVING.'
            : `"No results" alerts aren't available for ${sourceList}.`,
        });
      }
      modes.push({ ...shape.threshold, absenceAllowed });
    } else {
      unsupported.push(sourceModeIssue("threshold", sourceList));
    }
  }
  if (shape.match) {
    if (allowed.includes("match")) modes.push(shape.match);
    else unsupported.push(sourceModeIssue("match", sourceList));
  }

  const columns = compiled.map((c, i) => ({
    name: c.name,
    type: c.type,
    role: roleOf(c, i, shape),
  }));
  const analysis = result({ sources, tables, columns, modes });
  const first = analysis.modes[0];
  if (first) {
    analysis.suggestedName = suggestQueryAlertName(analysis, {
      mode: first.mode,
      measure: first.mode === "threshold" ? first.measures[0]?.column : undefined,
    });
  }
  return analysis;
}

function sourceModeIssue(mode: QueryMode, sourceList: string) {
  const what = mode === "match" ? "New-row alerts" : "Threshold alerts";
  return {
    mode,
    code: "source_mode",
    message: `${what} aren't available for ${sourceList}.`,
  };
}

function parseErrorMessage(error: unknown): string {
  return error instanceof ExposedTSQLError ? error.message : "The query could not be parsed.";
}

function sourceRefs(selects: SelectQuery[], tables: string[]): QueryAlertAnalysis["sources"] {
  const refs = selects.flatMap(fromEntries);
  return tables.flatMap((table) => {
    const aliases = [
      ...new Set(
        refs.flatMap((r) =>
          r.kind === "table" && r.table === table && r.name !== table ? [r.name] : []
        )
      ),
    ];
    return aliases.length
      ? aliases.map((alias) => ({ sourceId: table, alias }))
      : [{ sourceId: table }];
  });
}

function checkTables(
  selects: SelectQuery[],
  tables: string[],
  schemas: Map<string, TableSchema>,
  flags: AnalyzeQueryContext["flags"],
  errors: Issue[]
) {
  const unknown = new Set(
    selects
      .flatMap(fromEntries)
      .flatMap((e) => (e.kind === "table" && !schemas.has(e.table) ? [e.table] : []))
  );
  for (const table of unknown) {
    errors.push({ code: "unknown_table", message: `Table "${table}" doesn't exist.` });
  }
  if (!tables.length && !unknown.size) {
    errors.push({ code: "no_sources", message: "The query must read from at least one table." });
  }
  for (const table of tables) {
    const source = getQuerySource(table);
    if (!source) {
      errors.push({
        code: "not_alert_source",
        message: `Alerts can't watch the "${table}" table.`,
      });
    } else if (source.flag && !flags[source.flag]) {
      errors.push({
        code: "source_disabled",
        message: `The "${table}" table isn't available for alerts yet.`,
      });
    }
  }
}

function checkLimits(selects: SelectQuery[], errors: Issue[]) {
  if (selects.some((s) => s.limit || s.offset || s.limit_by || s.limit_with_ties)) {
    errors.push({
      code: "limit",
      message:
        "Remove LIMIT, OFFSET and LIMIT BY: an alert looks at every matching row, and a top-N cut makes it fire on ranking changes.",
    });
  }
}

function checkWindowColumns(selects: SelectQuery[], tables: string[], errors: Issue[]) {
  const windowColumns = new Map(
    tables.map((t) => {
      const source = getQuerySource(t);
      if (!source) return [t, [] as string[]];
      const { threshold, match } = source.timeColumns;
      return [t, source.modes.includes("match") && match ? [threshold, match] : [threshold]];
    })
  );
  const used = new Set<string>();
  let touched = false;
  let unverifiable = false;
  const rule = {
    buckets: false,
    onUnverifiable: () => {
      unverifiable = true;
    },
    isTimeColumn: (table: string, column: string) => {
      const hit = !!windowColumns.get(table)?.includes(column);
      if (hit) used.add(column);
      return hit;
    },
  };
  for (const query of selects) {
    const filters = [
      query.where,
      query.prewhere,
      query.having,
      ...fromEntries(query).map((e) => e.ref.constraint),
    ];
    for (const filter of filters) {
      if (filter && touchesTime(query, filter, rule)) touched = true;
    }
  }
  if (used.size) {
    errors.push({
      code: "window_column_filter",
      message: `Remove the filter on ${[...used].join(", ")}: the alert window owns time.`,
    });
  } else if (touched && unverifiable) {
    errors.push({
      code: "union_star_unverifiable",
      message:
        "Filters over a UNION with a `*` branch can't be checked; list the columns explicitly instead of `*`.",
    });
  }
}

type Shape = { threshold?: Omit<ThresholdMode, "absenceAllowed">; match?: MatchMode };

function analyzeShape(
  root: AnyQuery,
  compiled: OutputColumnMetadata[],
  schemas: Map<string, TableSchema>,
  tables: string[],
  unsupported: QueryAlertAnalysis["unsupported"]
): Shape {
  const branches = branchesOf(root);
  const push = (modes: QueryMode[], code: string, message: string) => {
    for (const mode of modes) unsupported.push({ mode, code, message });
  };

  if (allSelects(root).some((s) => s.select.some(containsWindowFunction))) {
    push(
      ["threshold", "absence", "match"],
      "ranked",
      "Ranking and window functions (rank, row_number, …) aren't supported in alerts."
    );
    return {};
  }

  const aggregated = branches.some(
    (b) => b.group_by?.length || b.select.some((item) => containsAggregate(item))
  );
  if (!aggregated) {
    push(
      ["threshold", "absence"],
      "rows_need_aggregate",
      "Threshold alerts need an aggregate such as count() or avg()."
    );
    const match = analyzeMatch(root, schemas);
    if (!match.ok) {
      push(["match"], match.code, match.message);
      return {};
    }
    const misnamed = [match.idIndex, match.eventIndex].some((i) => {
      const expected = itemName(branches[0]!.select[i]!);
      return expected !== undefined && expected !== compiled[i]?.name;
    });
    if (misnamed) {
      push(
        ["match"],
        "unnamed_column",
        "Name the row id and time columns with AS, e.g. x.run_id AS run_id."
      );
      return {};
    }
    return {
      match: {
        mode: "match",
        sourceId: match.source.table,
        rowIdColumn: compiled[match.idIndex]!.name,
        eventColumn: compiled[match.eventIndex]!.name,
      },
    };
  }

  push(
    ["match"],
    "aggregated",
    "New-row alerts need one result row per source row, without GROUP BY or aggregates."
  );
  if (branches.length > 1) {
    push(
      ["threshold", "absence"],
      "union_aggregate",
      "A UNION of aggregates returns several values; wrap it in an outer query that combines them, e.g. SELECT sum(c) FROM (… UNION ALL …)."
    );
    return {};
  }

  const query = branches[0]!;
  const items = query.select;
  const visible = visibleColumns(query, schemas, tables);
  const aliases = items.flatMap((item) =>
    item.expression_type === "alias" ? [(item as Alias).alias.toLowerCase()] : []
  );
  const ambiguous = new Set(aliases.filter((a, i) => aliases.indexOf(a) !== i));
  const aggregateAliases = new Set<string>();
  const isAggregateRef = (f: Field) => {
    const name = String(f.chain[0]);
    return f.chain.length === 1 && !visible.has(name) && aggregateAliases.has(name.toLowerCase());
  };
  const isAggregateItem = (item: Expression) =>
    (containsAggregate(item) || fieldsIn(item).some(isAggregateRef)) &&
    !hasFreeField(item, isAggregateRef);
  for (let grew = true; grew;) {
    grew = false;
    for (const item of items) {
      const alias = item.expression_type === "alias" ? (item as Alias).alias.toLowerCase() : "";
      if (alias && !ambiguous.has(alias) && !aggregateAliases.has(alias) && isAggregateItem(item)) {
        aggregateAliases.add(alias);
        grew = true;
      }
    }
  }
  const aggregateItem = items.map(isAggregateItem);
  const grouped = !!query.group_by?.length;

  if (!grouped && aggregateItem.some((a) => !a)) {
    push(
      ["threshold", "absence"],
      "mixed_aggregates",
      "Without GROUP BY every column must be an aggregate; add the other columns to GROUP BY."
    );
    return {};
  }
  const groupItems = items.filter((_, i) => !aggregateItem[i]);
  const groupTypes = items.flatMap((_, i) => (aggregateItem[i] ? [] : [compiled[i]?.type ?? ""]));
  if (grouped && groupsByTime(query, schemas, groupTypes)) {
    push(
      ["threshold", "absence"],
      "group_by_time",
      "Remove time buckets from GROUP BY: the alert evaluates one window at a time."
    );
    return {};
  }
  if (grouped && groupsUnprojected(query, groupItems)) {
    push(
      ["threshold", "absence"],
      "group_by_unprojected",
      "Select every GROUP BY expression as a column so each group can be told apart."
    );
    return {};
  }

  const measures = items.flatMap((item, i) => {
    const column = compiled[i];
    if (!aggregateItem[i] || !column || !NUMERIC_TYPE.test(column.type)) return [];
    return [
      {
        column: column.name,
        type: column.type,
        ...(column.format ? { format: column.format } : {}),
        // HAVING can drop the row, so an empty result doesn't prove a zero count.
        countLike: !query.having && isCountLike(item, tables),
      },
    ];
  });
  if (!measures.length) {
    push(
      ["threshold", "absence"],
      "no_numeric_measure",
      "Add a numeric aggregate such as count() or avg(…) to alert on."
    );
    return {};
  }

  return {
    threshold: {
      mode: "threshold",
      shape: grouped ? "grouped" : "scalar",
      measures,
      groupColumns: grouped
        ? items.flatMap((_, i) => (aggregateItem[i] || !compiled[i] ? [] : [compiled[i]!.name]))
        : [],
    },
  };
}

function visibleColumns(
  query: SelectQuery,
  schemas: Map<string, TableSchema>,
  tables: string[]
): Set<string> {
  const columnsOf = (table: string) => Object.keys(schemas.get(table)?.columns ?? {});
  return new Set(
    fromEntries(query).flatMap((entry) => {
      if (entry.kind === "table") return columnsOf(entry.table);
      const select = branchesOf(entry.query)[0]?.select ?? [];
      if (select.some(isStar)) return tables.flatMap(columnsOf);
      return select.flatMap((item) => itemName(item) ?? []);
    })
  );
}

function groupsByTime(
  query: SelectQuery,
  schemas: Map<string, TableSchema>,
  groupTypes: string[]
): boolean {
  if (groupTypes.some((type) => TIME_TYPE.test(type))) return true;
  const rule = {
    buckets: true,
    isTimeColumn: (table: string, column: string) => {
      const type = schemas.get(table)?.columns[column]?.type;
      return !!type && TIME_TYPE.test(type);
    },
  };
  return (query.group_by ?? []).some((expr) => touchesTime(query, expr, rule));
}

function sameExpr(a: Expression, b: Expression): boolean {
  const strip = (e: Expression) =>
    JSON.stringify(e, (key, value) => (key === "start" || key === "end" ? undefined : value));
  return strip(a) === strip(b);
}

function groupsUnprojected(query: SelectQuery, groupItems: Expression[]): boolean {
  if (!groupItems.length) return true;
  return (query.group_by ?? []).some(
    (expr) =>
      !groupItems.some(
        (item) =>
          sameExpr(unwrapAlias(item), expr) ||
          (isField(expr) && expr.chain.length === 1 && itemName(item) === String(expr.chain[0]))
      )
  );
}

function isCountLike(item: Expression, tables: string[]): boolean {
  const expr = unwrapAlias(item);
  if (expr.expression_type !== "call") return false;
  const call = expr as Call;
  const name = call.name.toLowerCase();
  if (name === "count" || name === "countif") return true;
  if (name !== "sum" && name !== "sumif") return false;
  const arg = call.args[0];
  const countColumns = new Set(tables.flatMap((t) => COUNT_COLUMNS[t] ?? []));
  return !!arg && isField(arg) && countColumns.has(lastName(arg));
}

function roleOf(
  column: OutputColumnMetadata,
  index: number,
  shape: Shape
): QueryAlertAnalysis["columns"][number]["role"] {
  if (shape.threshold?.measures.some((m) => m.column === column.name)) return "measure";
  if (shape.threshold?.groupColumns.includes(column.name)) return "group";
  if (shape.match?.rowIdColumn === column.name) return "rowId";
  if (shape.match?.eventColumn === column.name || TIME_TYPE.test(column.type)) return "time";
  return "other";
}

function fallbackName(query: string): string {
  const text = query.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 79)}…` : text || "Query alert";
}

export function suggestQueryAlertName(
  analysis: QueryAlertAnalysis,
  choice: QueryAlertChoice & { direction?: "above" | "below" }
): string {
  const sources = [...new Set(analysis.sources.map((s) => s.sourceId))].join(", ");
  if (choice.mode === "match") {
    const match = analysis.modes.find((m): m is MatchMode => m.mode === "match");
    return match ? `New ${match.sourceId} rows matching the query` : fallbackName("");
  }
  const threshold = analysis.modes.find((m): m is ThresholdMode => m.mode === "threshold");
  const measure = choice.measure ?? threshold?.measures[0]?.column;
  if (!threshold || !measure) return fallbackName("");
  const by = threshold.groupColumns.length ? ` by ${threshold.groupColumns.join(", ")}` : "";
  if (choice.mode === "absence") return `No ${measure} on ${sources}${by}`;
  const direction = choice.direction ? ` ${choice.direction} threshold` : "";
  return `${measure}${direction} on ${sources}${by}`;
}

export type QuerySignalResult = { ok: true; signal: QuerySignal } | { ok: false; message: string };

/** Why a threshold/absence window can't be used with this query, if it can't. */
export function queryWindowIssue(
  analysis: QueryAlertAnalysis,
  windowSec: number
): string | undefined {
  const { minCadenceSec, maxWindowSec } = analysis.limits;
  if (windowSec >= minCadenceSec && windowSec <= maxWindowSec) return undefined;
  const sources = [...new Set(analysis.sources.map((source) => source.sourceId))].join(", ");
  return `${sources} needs a window of at least ${minCadenceSec / 60} minutes (max ${maxWindowSec / 3600} h)`;
}

export function toQuerySignal(
  analysis: QueryAlertAnalysis,
  choice: QueryAlertChoice
): QuerySignalResult {
  if (!analysis.ok) return { ok: false, message: "The query can't be used for an alert." };
  const sourceIds = [...new Set(analysis.sources.map((s) => s.sourceId))];
  const windowFor = (sourceId: string, matchSource?: string) => {
    const source = getQuerySource(sourceId)!;
    return {
      sourceId,
      windowColumn:
        sourceId === matchSource ? source.timeColumns.match! : source.timeColumns.threshold,
    };
  };

  if (choice.mode === "match") {
    const match = analysis.modes.find((m): m is MatchMode => m.mode === "match");
    if (!match) return { ok: false, message: "New-row alerts aren't available for this query." };
    return {
      ok: true,
      signal: querySignalSchema.parse({
        v: 1,
        sources: sourceIds.map((id) => windowFor(id, match.sourceId)),
        mode: "match",
        rowId: {
          sourceId: match.sourceId,
          column: match.rowIdColumn,
          eventColumn: match.eventColumn,
        },
      }),
    };
  }

  const threshold = analysis.modes.find((m): m is ThresholdMode => m.mode === "threshold");
  if (!threshold)
    return { ok: false, message: "Threshold alerts aren't available for this query." };
  if (!choice.measure && threshold.measures.length > 1) {
    return {
      ok: false,
      message: `Choose a measure: ${threshold.measures.map((m) => m.column).join(", ")}.`,
    };
  }
  const measure = threshold.measures.find(
    (m) => m.column === (choice.measure ?? threshold.measures[0]!.column)
  );
  if (!measure) return { ok: false, message: `"${choice.measure}" isn't a measure of this query.` };
  if (choice.mode === "absence" && !(threshold.absenceAllowed && measure.countLike)) {
    return { ok: false, message: `"No results" alerts need a count() measure.` };
  }
  return {
    ok: true,
    signal: querySignalSchema.parse({
      v: 1,
      sources: sourceIds.map((id) => windowFor(id)),
      mode: choice.mode,
      measure: measure.column,
      ...(threshold.groupColumns.length ? { groupColumns: threshold.groupColumns } : {}),
    }),
  };
}
