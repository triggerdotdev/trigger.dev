import { getQuerySource } from "@internal/alert-contracts";
import type { QueryAlertAnalysis } from "~/v3/services/alerts/queryAlerts/analyzeQueryForAlert.server";
import { parsePeriodToMs } from "~/utils/periods";

export const MAX_WATCH_QUERY_LENGTH = 8192;
const MAX_DEFAULT_WINDOW_MINUTES = 24 * 60;
export const UNUSABLE_QUERY = "This query can't be used for an alert.";

const MODE_MISMATCH_CODES = new Set(["aggregated", "rows_need_aggregate"]);

export type QueryAlertMode = "threshold" | "absence" | "match";

export type QueryAlertPrefill = {
  query: string;
  period: string;
  analysis: QueryAlertAnalysis;
  names: Record<string, string>;
  mode?: QueryAlertMode;
  measure?: string;
  operator?: ">" | "<";
  value?: number;
  windowSec?: number;
};

export function queryAlertNameKey(mode: QueryAlertMode, measure?: string) {
  return `${mode}:${measure ?? ""}`;
}

export function encodeQueryParam(query: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(query)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeQueryParam(value: string): string | undefined {
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(binary, (char) => char.charCodeAt(0))
    );
  } catch {
    return undefined;
  }
}

export function watchBlockedReasons(analysis: QueryAlertAnalysis, query: string): string[] {
  if (encodeQueryParam(query).length > MAX_WATCH_QUERY_LENGTH)
    return ["Query is too long to watch"];
  if (analysis.ok && analysis.modes.length > 0) return [];
  const matchable = analysis.sources.some((s) =>
    getQuerySource(s.sourceId)?.modes.includes("match")
  );
  const issues = [
    ...analysis.errors,
    ...analysis.unsupported.filter((issue) => matchable || issue.mode !== "match"),
  ];
  const specific = issues.filter((issue) => !MODE_MISMATCH_CODES.has(issue.code));
  const messages = (specific.length ? specific : issues).map((issue) => issue.message);
  const unique = [...new Set(messages)].slice(0, 2);
  return unique.length ? unique : [UNUSABLE_QUERY];
}

export function watchQueryHref(
  alertsPath: string,
  query: string,
  period: string,
  analysis: QueryAlertAnalysis
): string {
  const params = new URLSearchParams({
    create: "1",
    source: "query",
    q: encodeQueryParam(query),
    qperiod: period,
  });
  const choice = watchQueryChoice(analysis);
  if (choice.mode) params.set("mode", choice.mode);
  if (choice.measure) params.set("measure", choice.measure);
  return `${alertsPath}?${params.toString()}`;
}

export function watchQueryChoice(analysis: QueryAlertAnalysis): {
  mode?: QueryAlertMode;
  measure?: string;
} {
  const [only] = analysis.modes;
  if (analysis.modes.length !== 1 || !only) return {};
  if (only.mode === "threshold" && only.measures.length === 1 && only.measures[0]) {
    return { mode: only.mode, measure: only.measures[0].column };
  }
  return { mode: only.mode };
}

export function queryWindowBounds(limits: QueryAlertAnalysis["limits"]) {
  return {
    min: Math.max(1, Math.ceil(limits.minCadenceSec / 60)),
    max: Math.floor(limits.maxWindowSec / 60),
  };
}

export function defaultQueryWindowMinutes(
  period: string,
  limits: QueryAlertAnalysis["limits"]
): number {
  const { min, max } = queryWindowBounds(limits);
  const periodMinutes = Math.floor(parsePeriodToMs(period) / 60_000);
  return Math.min(Math.max(Math.min(periodMinutes, MAX_DEFAULT_WINDOW_MINUTES), min), max);
}

export type QuerySignalOption = {
  id: string;
  label: string;
  mode: "threshold" | "match";
  measure?: string;
};

export function querySignalOptions(analysis: QueryAlertAnalysis): QuerySignalOption[] {
  return analysis.modes.flatMap((mode): QuerySignalOption[] =>
    mode.mode === "threshold"
      ? mode.measures.map((measure) => ({
          id: `threshold:${measure.column}`,
          label: measure.column,
          mode: "threshold",
          measure: measure.column,
        }))
      : [{ id: "match", label: `New ${mode.sourceId} rows`, mode: "match" }]
  );
}

export const QUERY_CONDITION_LABELS: Record<QueryAlertMode, string> = {
  threshold: "Value crosses a threshold",
  match: "New matching results appear",
  absence: "No matching results for the window",
};

export function queryConditionModes(
  analysis: QueryAlertAnalysis,
  signal: QuerySignalOption | undefined
): QueryAlertMode[] {
  if (!signal) return [];
  if (signal.mode === "match") return ["match"];
  const threshold = analysis.modes.find((mode) => mode.mode === "threshold");
  if (threshold?.mode !== "threshold") return ["threshold"];
  const measure = threshold.measures.find((m) => m.column === signal.measure);
  return threshold.absenceAllowed && measure?.countLike ? ["threshold", "absence"] : ["threshold"];
}
