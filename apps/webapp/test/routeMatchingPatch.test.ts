import { matchRoutes, type RouteObject } from "@remix-run/router";
import { describe, expect, it } from "vitest";

/**
 * Guards `patches/@remix-run__router@1.23.3.patch`.
 *
 * The patch buckets ranked route branches by their first static path segment so
 * a request only scans branches that could match it. That is a change to the
 * matcher's search order, so these cases pin the behaviour that must survive
 * it: branches whose leading segment is dynamic, splat or optional have to stay
 * reachable from every pathname, case-insensitive matching has to keep working
 * across the bucket lookup, and a more specific static route must still beat a
 * dynamic one.
 *
 * If the patch is ever dropped, these should still pass against the stock
 * matcher — they assert matching semantics, not the optimisation.
 */
const routes: RouteObject[] = [
  {
    id: "root",
    path: "/",
    children: [
      { id: "index", index: true },
      { id: "engine-dequeue", path: "engine/v1/worker-actions/dequeue" },
      {
        id: "engine-heartbeat",
        path: "engine/v1/worker-actions/runs/:runFriendlyId/snapshots/:snapshotFriendlyId/heartbeat",
      },
      { id: "engine-splat", path: "engine/*" },
      { id: "api-run", path: "api/v1/runs/:runId" },
      { id: "api-summary", path: "api/v1/runs/summary" },
      { id: "case-sensitive", path: "Engine/CaseCheck", caseSensitive: true },
      { id: "optional-lang", path: ":lang?/docs" },
      { id: "org-project", path: ":org/projects/:projectId" },
      { id: "orgs-settings", path: "orgs/settings" },
      { id: "orgs-dynamic", path: "orgs/:orgSlug" },
      { id: "catch-all", path: "*" },
    ],
  },
];

function matchedIds(pathname: string, basename?: string): string[] | null {
  const matches = matchRoutes(routes, pathname, basename);
  return matches ? matches.map((match) => match.route.id!) : null;
}

function paramsFor(pathname: string): Record<string, string | undefined> {
  const matches = matchRoutes(routes, pathname);
  return matches ? matches[matches.length - 1]!.params : {};
}

describe("route matching (patched matcher)", () => {
  it("matches a fully static engine route", () => {
    expect(matchedIds("/engine/v1/worker-actions/dequeue")).toEqual(["root", "engine-dequeue"]);
  });

  it("matches a dynamic engine route and extracts params", () => {
    const pathname = "/engine/v1/worker-actions/runs/run_abc/snapshots/snap_def/heartbeat";
    expect(matchedIds(pathname)).toEqual(["root", "engine-heartbeat"]);
    expect(paramsFor(pathname)).toMatchObject({
      runFriendlyId: "run_abc",
      snapshotFriendlyId: "snap_def",
    });
  });

  it("prefers a static route over a dynamic sibling at the same depth", () => {
    expect(matchedIds("/api/v1/runs/summary")).toEqual(["root", "api-summary"]);
    expect(matchedIds("/api/v1/runs/run_abc")).toEqual(["root", "api-run"]);
    expect(matchedIds("/orgs/settings")).toEqual(["root", "orgs-settings"]);
    expect(matchedIds("/orgs/acme")).toEqual(["root", "orgs-dynamic"]);
  });

  it("falls back to a splat within the same first segment", () => {
    expect(matchedIds("/engine/something/unrouted")).toEqual(["root", "engine-splat"]);
  });

  it("keeps routes with a dynamic first segment reachable", () => {
    expect(matchedIds("/acme/projects/proj_1")).toEqual(["root", "org-project"]);
    expect(paramsFor("/acme/projects/proj_1")).toMatchObject({
      org: "acme",
      projectId: "proj_1",
    });
  });

  it("keeps routes with an optional first segment reachable both ways", () => {
    expect(matchedIds("/docs")).toEqual(["root", "optional-lang"]);
    expect(matchedIds("/en/docs")).toEqual(["root", "optional-lang"]);
  });

  it("matches case-insensitively by default", () => {
    expect(matchedIds("/ENGINE/v1/worker-actions/dequeue")).toEqual(["root", "engine-dequeue"]);
    expect(matchedIds("/API/v1/runs/summary")).toEqual(["root", "api-summary"]);
  });

  it("honours caseSensitive routes", () => {
    expect(matchedIds("/Engine/CaseCheck")).toEqual(["root", "case-sensitive"]);
    expect(matchedIds("/engine/casecheck")).toEqual(["root", "engine-splat"]);
  });

  it("falls through to the global catch-all for an unknown first segment", () => {
    expect(matchedIds("/totally/unknown/path")).toEqual(["root", "catch-all"]);
  });

  it("matches the index route at the root", () => {
    expect(matchedIds("/")).toEqual(["root", "index"]);
  });

  it("still strips a basename before matching", () => {
    expect(matchedIds("/base/engine/v1/worker-actions/dequeue", "/base")).toEqual([
      "root",
      "engine-dequeue",
    ]);
    expect(matchRoutes(routes, "/elsewhere/engine", "/base")).toBeNull();
  });

  it("matches a percent-encoded first segment", () => {
    expect(matchedIds("/%65ngine/v1/worker-actions/dequeue")).toEqual(["root", "engine-dequeue"]);
  });
});
