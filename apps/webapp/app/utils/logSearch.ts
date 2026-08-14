export const MIN_LOGS_SEARCH_LENGTH = 3;
export const LOGS_SEARCH_RETRY_OVERFETCH_FACTOR = 4;

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

// Must match the normalization in ClickHouse migration 038.
export function normalizeLogsSearchTerm(value: string): string {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}_./:@+-]+/gu, " ")
    .trim();
}
