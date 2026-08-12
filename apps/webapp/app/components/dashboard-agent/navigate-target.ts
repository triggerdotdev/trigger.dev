// `trigger://` targets are resolved server-side in `resolveTriggerUri.server.ts`.
import { type RunFilters } from "@internal/dashboard-agent-contracts";
import { allTaskRunStatuses } from "~/components/runs/v3/TaskRunStatus";

// Filter keys are the runs page's own URL params, except that the page reads these
// bounds as epoch milliseconds while an intent carries ISO strings.
const EPOCH_MS_KEYS = new Set(["from", "to"]);

// The page's filter parser has no `search` param, so it would only clutter the URL.
const UNSUPPORTED_KEYS = new Set(["search"]);

type PageStatus = (typeof allTaskRunStatuses)[number];

const PAGE_STATUSES = new Set<string>(allTaskRunStatuses);

/** What a user means by "failed runs": every terminal status that is not a success or a cancel. */
const FAILING_STATUSES = [
  "COMPLETED_WITH_ERRORS",
  "SYSTEM_FAILURE",
  "CRASHED",
  "EXPIRED",
  "TIMED_OUT",
  "INTERRUPTED",
] as const satisfies readonly PageStatus[];

/** Statuses the API (and so the model) uses that the runs page has never heard of. */
const STATUS_ALIASES = {
  FAILED: FAILING_STATUSES,
  QUEUED: ["PENDING"],
  COMPLETED: ["COMPLETED_SUCCESSFULLY"],
  REATTEMPTING: ["RETRYING_AFTER_FAILURE"],
  FROZEN: ["WAITING_TO_RESUME"],
} as const satisfies Record<string, readonly PageStatus[]>;

/**
 * Statuses in the page's own vocabulary. One value it cannot parse makes it discard
 * every filter — the period too — so anything unrecognized is dropped, not sent.
 */
function pageStatuses(values: readonly string[]): string[] {
  const translated = new Set<string>();
  for (const value of values) {
    const status = value.trim().toUpperCase();
    if (PAGE_STATUSES.has(status)) {
      translated.add(status);
      continue;
    }
    for (const alias of STATUS_ALIASES[status as keyof typeof STATUS_ALIASES] ?? []) {
      translated.add(alias);
    }
  }
  return [...translated];
}

export function appendRunFilters(path: string, filters?: RunFilters): string {
  if (!filters) return path;
  // A base is needed to parse a relative path; only pathname + search is used.
  const url = new URL(path, "https://dashboard.invalid");

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
    if (UNSUPPORTED_KEYS.has(key)) continue;
    if (key === "statuses") {
      const statuses = Array.isArray(value) ? value : [String(value)];
      for (const status of pageStatuses(statuses)) url.searchParams.append(key, status);
      continue;
    }
    if (EPOCH_MS_KEYS.has(key)) {
      const epochMs = Date.parse(String(value));
      if (!Number.isNaN(epochMs)) url.searchParams.set(key, String(epochMs));
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) if (entry) url.searchParams.append(key, entry);
      continue;
    }
    if (typeof value === "boolean") {
      if (value) url.searchParams.set(key, "true");
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return `${url.pathname}${url.search}`;
}

export type NavigateDestination =
  | { kind: "route"; path: string }
  | { kind: "external"; url: string }
  | { kind: "none" };

/**
 * What the host should do with a resolved navigate target. A `trigger://source/…` resolves to a
 * file on GitHub, which the router cannot route: handed to `navigate` it lands on a dead
 * dashboard path. Only a root-relative path is ever routed, whatever the server said.
 */
export function navigateDestination(
  resolved: { path?: string | null; external?: boolean } | null | undefined,
  filters?: RunFilters
): NavigateDestination {
  const target = resolved?.path;
  if (!target) return { kind: "none" };

  // `/\` too: a URL parser maps the backslash to a slash, so it leaves the origin.
  const routable = !resolved?.external && target.startsWith("/") && !/^\/[/\\]/.test(target);
  if (routable) return { kind: "route", path: appendRunFilters(target, filters) };

  // Run filters belong to the runs page, so they are dropped rather than pushed onto a foreign URL.
  return /^https?:\/\//i.test(target) ? { kind: "external", url: target } : { kind: "none" };
}

// Null when the link leaves the dashboard.
export function sameOriginPath(href: string, origin: string): string | null {
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}
