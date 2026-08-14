export const MIN_LOGS_SEARCH_LENGTH = 3;
export const LOGS_SEARCH_RETRY_OVERFETCH_FACTOR = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_COMPARISON_TOLERANCE_MS = 1000;

export function logsSearchExpansionPeriod(
  from: Date | undefined,
  to: Date,
  retentionLimitDays: number | undefined
): string | undefined {
  if (!from) return undefined;

  const candidateDays = Math.min(retentionLimitDays ?? 7, 7);
  const currentRangeMs = Math.max(0, to.getTime() - from.getTime());
  if (candidateDays * DAY_MS <= currentRangeMs + RANGE_COMPARISON_TOLERANCE_MS) {
    return undefined;
  }

  return `${candidateDays}d`;
}

type ProjectedLogIdentity = {
  projection_fingerprint_string?: string;
  trace_id: string;
  span_id: string;
  run_id: string;
  start_time: string;
};

export function prepareLogsSearchPage<T extends ProjectedLogIdentity>(
  rows: T[],
  pageSize: number,
  queryLimit: number
): { rows: T[]; hasMore: boolean } {
  const seen = new Set<string>();
  const uniqueRows = rows.filter((row) => {
    const identity =
      row.projection_fingerprint_string ??
      JSON.stringify([row.trace_id, row.span_id, row.run_id, row.start_time]);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });

  return {
    rows: uniqueRows.slice(0, pageSize),
    hasMore: uniqueRows.length > pageSize || rows.length === queryLimit,
  };
}

export function hasMinimumLogsSearchLength(value: string): boolean {
  return [...value.trim()].length >= MIN_LOGS_SEARCH_LENGTH;
}

export function escapeClickHouseLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

// Must match the scheduled ClickHouse projector normalization.
export function normalizeLogsSearchTerm(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_./:@+-]+/gu, " ")
    .replace(/\s*:\s*/g, ":")
    .trim();
}
