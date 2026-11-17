import {
  querySignalOptions,
  UNUSABLE_QUERY,
  watchBlockedReasons,
  type QueryAlertPrefill,
} from "~/components/alerts/queryAlertLink";
import { v3EnvironmentPath } from "~/utils/pathBuilder";

export type Analyzed = Pick<QueryAlertPrefill, "analysis" | "names">;

export function queryAnalyzePath(...scope: Parameters<typeof v3EnvironmentPath>) {
  return `/resources${v3EnvironmentPath(...scope)}/alerts/analyze-query`;
}

export async function fetchQueryAnalysis(analyzePath: string, query: string) {
  try {
    const resp = await fetch(analyzePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    return resp.ok ? ((await resp.json()) as Analyzed) : ("error" as const);
  } catch {
    return "error" as const;
  }
}

export function analysisReasons(analyzed: Analyzed, query: string): string[] {
  const blocked = watchBlockedReasons(analyzed.analysis, query);
  return blocked.length || querySignalOptions(analyzed.analysis).length
    ? blocked
    : [UNUSABLE_QUERY];
}
