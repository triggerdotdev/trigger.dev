// `trigger://` targets are resolved server-side in `resolveTriggerUri.server.ts`.
import { type RunFilters } from "@internal/dashboard-agent-contracts";

// Filter keys are the runs page's own URL params, except that the page reads these
// bounds as epoch milliseconds while an intent carries ISO strings.
const EPOCH_MS_KEYS = new Set(["from", "to"]);

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

  const routable = !resolved?.external && target.startsWith("/") && !target.startsWith("//");
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
