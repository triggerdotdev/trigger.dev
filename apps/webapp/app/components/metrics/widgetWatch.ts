import { analysisReasons, fetchQueryAnalysis } from "~/components/alerts/queryAnalysis";
import type { useDashboardAgent } from "~/components/dashboard-agent/dashboardAgentLauncher";
import { MAX_MESSAGE_CHARS } from "~/components/dashboard-agent/message-limits";

type Agent = NonNullable<ReturnType<typeof useDashboardAgent>>;

export type WatchFilters = { scope?: string; lists: { label: string; values: string[] }[] };

const MIN_SQL_CHARS = 1500;
const SHORTENED_NOTE = "(The query was shortened to fit.)";
const INCOMPLETE_NOTE =
  "The filter lists above are incomplete: ask me for the full lists before creating the alert.";
const FILTER_LABELS = {
  taskIdentifiers: "Tasks",
  queues: "Queues",
  responseModels: "Models",
  promptSlugs: "Prompts",
  promptVersions: "Prompt versions",
  operations: "Operations",
  providers: "Providers",
  tags: "Tags",
} as const;

export function activeWatchFilters(
  scope: string | undefined,
  filters: Partial<Record<keyof typeof FILTER_LABELS, (string | number)[]>>
): WatchFilters | undefined {
  const lists = (Object.keys(FILTER_LABELS) as (keyof typeof FILTER_LABELS)[]).flatMap((key) => {
    const values = filters[key]?.map(String) ?? [];
    return values.length ? [{ label: FILTER_LABELS[key], values }] : [];
  });
  return lists.length ? { scope, lists } : undefined;
}

function filtersBlock({ scope, lists }: WatchFilters, maxValues: number) {
  const lines = lists.map(({ label, values }) => {
    const more = values.length - maxValues;
    if (more <= 0) return `- ${label}: ${values.join(", ")}`;
    const shown = values.slice(0, maxValues).join(", ");
    return `- ${label}: ${shown ? `${shown} and ${more} more` : `${more} values`}`;
  });
  if (scope && scope !== "environment") lines.push(`- Scope: ${scope}`);
  return [
    "Dashboard filters on this chart:",
    lines.join("\n"),
    "Apply them in the alert query.",
  ].join("\n");
}

// With filters the message always fits `limit`: every filter value is sent while it fits,
// shrinking the SQL first and capping the value lists only as a last resort.
function widgetWatchMessage({
  title,
  period,
  reasons,
  filters,
  query,
  limit,
}: {
  title?: string;
  period?: string;
  reasons: string[];
  filters?: WatchFilters;
  query: string;
  limit: number;
}) {
  const why = reasons.length
    ? reasons.slice(0, 2).join(" ")
    : "the dashboard filters are not part of the query.";
  const build = (maxValues: number, sql: string, shortened: boolean, capped = false) =>
    [
      title ? `Chart: ${title}` : undefined,
      period ? `Period: ${period}` : undefined,
      "Help me set up an alert for what this chart shows.",
      `It can't be watched as written: ${why}`,
      filters ? filtersBlock(filters, maxValues) : undefined,
      capped ? INCOMPLETE_NOTE : undefined,
      "```sql\n" + sql + "\n```",
      shortened ? SHORTENED_NOTE : undefined,
    ]
      .filter(Boolean)
      .join("\n\n");

  const all = Infinity;
  const full = build(all, query, false);
  if (!filters || full.length <= limit) return full;
  const room = limit - build(all, "", true).length;
  if (room >= MIN_SQL_CHARS) return build(all, query.slice(0, room), true);
  for (const cap of [20, 5, 1]) {
    const left = limit - build(cap, "", true, true).length;
    if (left >= MIN_SQL_CHARS) return build(cap, query.slice(0, left), true, true);
  }
  return build(0, query.slice(0, Math.max(limit - build(0, "", true, true).length, 0)), true, true);
}

// Unwatchable queries go to the agent as a normal chat turn (no `source`, which would
// enter creation mode and drop the message). Any failure falls back to the alert wizard.
export async function openWidgetWatch({
  agent,
  analyzePath,
  query,
  period,
  title,
  filters,
}: {
  agent: Agent;
  analyzePath?: string;
  query: string;
  period?: string;
  title?: string;
  filters?: WatchFilters;
}) {
  const createAlert = () => agent.openCreateAlert({ source: "query", query, period });
  if (!analyzePath) return createAlert();
  const analyzed = await fetchQueryAnalysis(analyzePath, query);
  if (analyzed === "error") return createAlert();
  const reasons = analysisReasons(analyzed, query);
  if (!reasons.length && !filters) return createAlert();
  const text = widgetWatchMessage({
    title,
    period,
    reasons,
    filters,
    query,
    limit: MAX_MESSAGE_CHARS,
  });
  if (text.length > MAX_MESSAGE_CHARS) return createAlert();
  agent.openWith(text, { newChat: true });
}
