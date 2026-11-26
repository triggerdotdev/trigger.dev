/** The page's URL params that choose which events the list shows: every one but paging and selection. */
const FILTER_PARAMS = [
  "category",
  "action",
  "actor",
  "project",
  "environment",
  "target",
  "key",
  "credential",
  "via",
  "period",
  "from",
  "to",
] as const;

/**
 * The filters of a page URL as a stable query string (`credential=key%3Aabc&period=7d`): what the
 * credential summary is loaded for and keyed on, so a response for other filters is never shown.
 */
export function auditLogSummarySearch(params: URLSearchParams): string {
  const filters = new URLSearchParams();
  for (const name of FILTER_PARAMS) {
    const value = params.get(name);
    if (value !== null) filters.set(name, value);
  }
  return filters.toString();
}

/**
 * The summary's filters with the page's resolved time range in place of a relative one: "7 days"
 * read again when the summary loads would end later than the list's range.
 */
export function auditLogSummaryRangeSearch(
  search: string,
  range: { from: number; to: number }
): string {
  const params = new URLSearchParams(search);
  params.delete("period");
  params.set("from", String(range.from));
  params.set("to", String(range.to));
  // In the order the summary route echoes its filters, or the page never takes its answer.
  return auditLogSummarySearch(params);
}

/** Where the page loads its credential summary from. */
export function auditLogSummaryPath(organizationSlug: string, search: string): string {
  return `/resources/orgs/${encodeURIComponent(organizationSlug)}/audit-log/summary?${search}`;
}
