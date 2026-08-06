import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_PAGE_SEGMENTS } from "./deeplinkPages";

// Flat-route prefix for every page that renders inside an environment. The trailing dot matters:
// it excludes the layout route itself (`…env.$envParam`), which has no segment of its own.
const ENV_ROUTE_PREFIX = "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.";

/**
 * Segments that are route files but not deeplink targets:
 * - `_index` is the environment root, which is already where an unrecognised deeplink lands.
 * - `queues_` is Remix's "opt out of the parent layout" spelling of `queues`, not a distinct URL.
 */
const NOT_DEEPLINKABLE = new Set(["_index", "queues_"]);

/** The first path segment of every environment page, read off the route filenames. */
function envRouteSegments(): Set<string> {
  const entries = readdirSync(join(__dirname, "../routes"));
  const segments = new Set<string>();

  for (const entry of entries) {
    if (!entry.startsWith(ENV_ROUTE_PREFIX)) continue;
    // `metrics.$dashboardKey.ts` -> `metrics`, `agents` -> `agents`, `errors._index` -> `errors`
    const segment = entry.slice(ENV_ROUTE_PREFIX.length).split(/[./]/)[0];
    // Guards against a future `…env.$envParam.tsx` contributing its extension as a segment.
    if (!segment || segment === "ts" || segment === "tsx") continue;
    if (NOT_DEEPLINKABLE.has(segment)) continue;
    segments.add(segment);
  }

  return segments;
}

describe("deeplink allowlist", () => {
  it("matches the environment layout's route segments", () => {
    // Sorted arrays rather than sets so a mismatch names the segment that drifted.
    expect([...ENV_PAGE_SEGMENTS].sort()).toEqual([...envRouteSegments()].sort());
  });

  it("found the routes directory", () => {
    // Guards the test itself: an empty derived set would make the assertion above vacuous
    // if the allowlist were ever emptied too.
    expect(envRouteSegments().size).toBeGreaterThan(20);
  });

  it("excludes the environment root and the layout-opt-out spelling", () => {
    expect(ENV_PAGE_SEGMENTS.has("_index")).toBe(false);
    expect(ENV_PAGE_SEGMENTS.has("queues_")).toBe(false);
    // `queues` itself is still reachable — it is the real URL segment.
    expect(ENV_PAGE_SEGMENTS.has("queues")).toBe(true);
  });

  it("includes the pages that ENV_PAGE_META omits", () => {
    // These have no entry in ENV_PAGE_META (their icon/label is special-cased when resolving
    // page metadata), which is why the allowlist is derived from routes and not from that map.
    for (const segment of ["tasks", "agents", "settings"]) {
      expect(ENV_PAGE_SEGMENTS.has(segment)).toBe(true);
    }
  });
});
