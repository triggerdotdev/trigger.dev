/**
 * Where a navigate goes, as a dashboard path.
 *
 * A `trigger://` target is resolved server-side in `resolveTriggerUri.server.ts`.
 * This module handles the client-side halves: the runs-list filters a navigate
 * intent carries, and links that arrived as absolute URLs into our own origin.
 */
import { type RunFilters } from "@internal/dashboard-agent-contracts";

// The filter keys are already the runs page's own URL params (see
// `TaskRunListSearchFilters`), with one exception: the page reads absolute
// window bounds as epoch milliseconds while an intent carries ISO strings.
const EPOCH_MS_KEYS = new Set(["from", "to"]);

/** A resolved path with the intent's filters applied as search params. */
export function appendRunFilters(path: string, filters?: RunFilters): string {
  if (!filters) return path;
  // A base is needed to parse a relative path; only pathname + search is used.
  const url = new URL(path, "https://dashboard.invalid");

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === "") continue;
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

/**
 * The path to navigate to for a link into our own origin, or null when the link
 * leaves the dashboard (those keep their new tab). The agent cites dashboard
 * resources as absolute URLs, which would otherwise render as external links.
 */
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
