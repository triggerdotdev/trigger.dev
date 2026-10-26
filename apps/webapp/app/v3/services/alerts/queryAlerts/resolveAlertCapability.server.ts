import {
  type AlertCapability,
  getCapability,
  getQuerySource,
  minCadenceForTables,
  QUERY_SOURCES,
  querySignalSchema,
  type QuerySignal,
} from "@internal/alert-contracts";
import { selectStatementText } from "@internal/tsql";
import { querySchemas } from "~/v3/querySchemas";
import { identifier } from "../evaluators/queryEvaluator.server";
import type { Alert } from "../storage/alertStore.server";
import {
  analyzeQueryForAlert,
  toQuerySignal,
  type QueryAlertAnalysis,
} from "./analyzeQueryForAlert.server";

export const CUSTOM_QUERY_CAPABILITY = "custom.query";

export type ResolvedAlertCapability = {
  capability: AlertCapability;
  unavailable?: { reason: string; code: string };
  /** The measure counts rows, so a window without rows is 0. */
  countLike?: boolean;
};

type Issue = { code: string; message: string };

// Source flags were checked when the alert was created.
const ALL_FLAGS = Object.fromEntries(
  Object.values(QUERY_SOURCES).flatMap((s) => (s.flag ? [[s.flag, true]] : []))
);

const CONDITION_KIND = { threshold: "threshold", absence: "absence", match: "occurrence" };

const CHANGED = "The query changed and no longer produces the signal this alert watches.";

export function resolveAlertCapability(
  alert: Pick<Alert, "capabilityKey" | "query" | "params" | "condition">
): ResolvedAlertCapability | undefined {
  const base = getCapability(alert.capabilityKey);
  if (!base || alert.capabilityKey !== CUSTOM_QUERY_CAPABILITY) {
    return base ? { capability: base } : undefined;
  }

  const invalid = (issue: Issue) => invalidCapability(base, issue);
  const parsed = querySignalSchema.safeParse(alert.params?.querySignal);
  if (!alert.query) {
    return invalid({ code: "missing_query", message: "The alert has no query." });
  }
  if (!parsed.success) {
    return invalid({ code: "missing_signal", message: "The alert has no query signal." });
  }
  const signal = parsed.data;
  if ((alert.condition as { kind?: unknown }).kind !== CONDITION_KIND[signal.mode]) {
    return invalid({ code: "condition_mismatch", message: CHANGED });
  }

  const analysis = analyzeQueryForAlert(alert.query, {
    tableSchemas: querySchemas,
    flags: ALL_FLAGS,
  });
  const mismatch = signalMismatch(analysis, signal);
  if (mismatch) return invalid(mismatch);

  return buildQueryCapability(alert.query, signal, analysis, base);
}

function invalidCapability(
  base: AlertCapability,
  { code, message }: Issue
): ResolvedAlertCapability {
  return {
    capability: base,
    unavailable: { reason: message, code: `query_invalid:${code}` },
  };
}

export function buildQueryCapability(
  query: string,
  signal: QuerySignal,
  analysis: QueryAlertAnalysis,
  base: AlertCapability
): ResolvedAlertCapability {
  const invalid = (issue: Issue) => invalidCapability(base, issue);
  const tables = [...new Set(signal.sources.map((s) => getQuerySource(s.sourceId)?.table))];
  const minCadenceSec = minCadenceForTables(tables.flatMap((t) => t ?? []));
  if (!minCadenceSec || tables.includes(undefined)) {
    return invalid({ code: "unknown_source", message: CHANGED });
  }

  const binding: AlertCapability["binding"] = signal.rowId
    ? {
        type: "query",
        source: "custom",
        emit: "rows",
        template: matchTemplate(
          selectStatementText(query),
          analysis.columns.map((c) => c.name),
          signal.rowId
        ),
        ctx: ["checkpoint", "until", "after"],
        rowKey: [signal.rowId.column],
        rowTimeColumn: signal.rowId.eventColumn,
        minCadenceSec,
      }
    : {
        type: "query",
        source: "custom",
        template: query,
        measure: signal.measure,
        groupBy: signal.groupColumns ?? [],
        minCadenceSec,
      };
  const countLike = analysis.modes.some(
    (m) =>
      m.mode === "threshold" && m.measures.some((x) => x.column === signal.measure && x.countLike)
  );
  return { capability: { ...base, minCadenceSec, binding }, countLike };
}

function signalMismatch(analysis: QueryAlertAnalysis, signal: QuerySignal): Issue | undefined {
  if (analysis.errors.length) return analysis.errors[0]!;
  const unsupported = () =>
    analysis.unsupported.find((u) => u.mode === signal.mode) ?? {
      code: "mode_unavailable",
      message: CHANGED,
    };
  const mode = signal.mode === "match" ? "match" : "threshold";
  const candidate = analysis.modes.find((m) => m.mode === mode);
  if (!candidate) return unsupported();
  if (
    candidate.mode === "threshold" &&
    !candidate.measures.some((m) => m.column === signal.measure)
  ) {
    return {
      code: "measure_missing",
      message: `The query no longer returns the "${signal.measure}" column this alert watches.`,
    };
  }
  const expected = toQuerySignal(analysis, { mode: signal.mode, measure: signal.measure });
  if (!expected.ok) return unsupported();
  return canonical(expected.signal) === canonical(signal)
    ? undefined
    : { code: "signal_changed", message: CHANGED };
}

function canonical(signal: QuerySignal): string {
  const sources = [...signal.sources].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  return JSON.stringify({ ...signal, sources });
}

function matchTemplate(
  statement: string,
  columns: string[],
  rowId: NonNullable<QuerySignal["rowId"]>
): string {
  const event = identifier(rowId.eventColumn);
  const id = identifier(rowId.column);
  return [
    `SELECT ${columns.map(identifier).join(", ")} FROM (`,
    statement,
    `) WHERE ${event} >= {{ctx.checkpoint}} AND ${event} < {{ctx.until}} AND {{ctx.after}}`,
    `ORDER BY ${event} ASC, ${id} ASC`,
  ].join("\n");
}
