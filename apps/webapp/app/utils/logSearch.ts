export const MIN_LOGS_SEARCH_LENGTH = 3;

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
