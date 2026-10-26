import {
  decodeQueryParam,
  MAX_WATCH_QUERY_LENGTH,
  queryAlertNameKey,
  querySignalOptions,
  UNUSABLE_QUERY,
  type QueryAlertMode,
  type QueryAlertPrefill,
} from "~/components/alerts/queryAlertLink";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { querySchemas } from "~/v3/querySchemas";
import {
  analyzeQueryForAlert,
  QUERY_ALERT_ANALYZER_VERSION,
  suggestQueryAlertName,
  type QueryAlertAnalysis,
} from "./analyzeQueryForAlert.server";

const MODES: QueryAlertMode[] = ["threshold", "absence", "match"];
const PERIOD_PATTERN = /^\d+[mhdw]$/;
const DEFAULT_PERIOD = "7d";

function analyzeDashboardQuery(query: string): QueryAlertAnalysis {
  return analyzeQueryForAlert(query.trim(), {
    tableSchemas: querySchemas,
    flags: { QUEUE_METRICS: env.QUEUE_METRICS_QUERY_TABLES_VISIBLE === "1" },
  });
}

type Analyze = (query: string) => QueryAlertAnalysis;

export function tryAnalyzeDashboardQuery(
  query: string,
  analyze: Analyze = analyzeDashboardQuery
): QueryAlertAnalysis | null {
  try {
    return analyze(query);
  } catch (error) {
    logger.warn("Failed to analyze query for Watch", { error });
    return null;
  }
}

function suggestedNames(analysis: QueryAlertAnalysis): Record<string, string> {
  const names: Record<string, string> = {};
  for (const signal of querySignalOptions(analysis)) {
    const modes: QueryAlertMode[] = signal.mode === "match" ? ["match"] : ["threshold", "absence"];
    for (const mode of modes) {
      names[queryAlertNameKey(mode, signal.measure)] = suggestQueryAlertName(analysis, {
        mode,
        measure: signal.measure,
      });
    }
  }
  return names;
}

function unusableAnalysis(code: string, message: string): QueryAlertAnalysis {
  return {
    ok: false,
    analyzerVersion: QUERY_ALERT_ANALYZER_VERSION,
    sources: [],
    columns: [],
    modes: [],
    unsupported: [],
    errors: [{ code, message }],
    limits: {
      minCadenceSec: 0,
      maxWindowSec: 86_400,
      maxGroups: 500,
      maxMatchRowsPerEval: 200,
      detailRows: 10,
    },
    suggestedName: "Query alert",
  };
}

export function analyzeQueryPrefill(
  query: string,
  analyze: Analyze = analyzeDashboardQuery
): Pick<QueryAlertPrefill, "analysis" | "names"> {
  const analysis = query
    ? (tryAnalyzeDashboardQuery(query, analyze) ??
      unusableAnalysis("analysis_failed", UNUSABLE_QUERY))
    : unusableAnalysis("missing_query", "The query is missing or too long to watch.");
  return { analysis, names: suggestedNames(analysis) };
}

export function queryAlertPrefill(
  searchParams: URLSearchParams,
  analyze: Analyze = analyzeDashboardQuery
): QueryAlertPrefill {
  const q = searchParams.get("q") ?? "";
  const query = q.length <= MAX_WATCH_QUERY_LENGTH ? (decodeQueryParam(q)?.trim() ?? "") : "";
  const period = searchParams.get("qperiod") ?? "";
  const mode = MODES.find((m) => m === searchParams.get("mode"));
  return {
    query,
    period: PERIOD_PATTERN.test(period) ? period : DEFAULT_PERIOD,
    ...analyzeQueryPrefill(query, analyze),
    mode,
    measure: searchParams.get("measure") ?? undefined,
  };
}
