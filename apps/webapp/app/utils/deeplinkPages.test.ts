import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ENV_PAGE_TARGETS, resolveDeeplinkPage } from "./deeplinkPages";

const ROUTES_DIR = join(__dirname, "../routes");

// Flat-route prefix for every page that renders inside an environment. The trailing dot matters:
// it excludes the layout route itself (`…env.$envParam`), which has no segment of its own.
const ENV_ROUTE_PREFIX = "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.";

/**
 * Segments that are route files but are not deeplink names:
 * - `_index` is the environment root. It is where an unrecognised deeplink already lands, and
 *   `tasks` is the name that points at it.
 * - `queues_` is Remix's "opt out of the parent layout" spelling of `queues`, not a distinct URL.
 */
const NOT_DEEPLINK_NAMES = new Set(["_index", "queues_"]);

const routeEntries = readdirSync(ROUTES_DIR);

/** A route directory only contributes a route if it actually holds a `route` module. */
function isRouteModule(entry: string): boolean {
  const path = join(ROUTES_DIR, entry);
  if (!statSync(path).isDirectory()) return true;
  return existsSync(join(path, "route.tsx")) || existsSync(join(path, "route.ts"));
}

/**
 * The route file that a bare `/env/{env}/{target}` URL matches, or undefined when nothing does.
 * `target` may span segments ("waitpoints/tokens"); "" is the environment root.
 *
 * Only literal route names are considered — a param route (`metrics.$dashboardKey`) is not a page
 * you can land on without supplying the param, which is exactly what this needs to reject.
 */
function routeForTarget(target: string): string | undefined {
  if (target === "") {
    return isRouteModule(`${ENV_ROUTE_PREFIX}_index`) ? `${ENV_ROUTE_PREFIX}_index` : undefined;
  }

  const base = ENV_ROUTE_PREFIX + target.split("/").join(".");
  // A leaf route, or a layout whose index child supplies the bare URL.
  return [base, `${base}.tsx`, `${base}.ts`, `${base}._index`].find(
    (candidate) => routeEntries.includes(candidate) && isRouteModule(candidate)
  );
}

/** Every first segment appearing under the environment layout. */
function envRouteSegments(): Set<string> {
  const segments = new Set<string>();
  for (const entry of routeEntries) {
    if (!entry.startsWith(ENV_ROUTE_PREFIX)) continue;
    // `metrics.$dashboardKey.ts` -> `metrics`, `agents` -> `agents`, `errors._index` -> `errors`
    const segment = entry.slice(ENV_ROUTE_PREFIX.length).split(/[./]/)[0];
    // Guards against a future `…env.$envParam.tsx` contributing its extension as a segment.
    if (!segment || segment === "ts" || segment === "tsx") continue;
    segments.add(segment);
  }
  return segments;
}

describe("deeplink targets", () => {
  it("found the routes directory", () => {
    // Without this, every assertion below would pass vacuously if the glob ever broke.
    expect(envRouteSegments().size).toBeGreaterThan(20);
  });

  it("every target resolves to a real environment route", () => {
    const unresolved = [...ENV_PAGE_TARGETS.entries()]
      .filter(([, target]) => !routeForTarget(target))
      .map(([name, target]) => `${name} -> ${target || "(environment root)"}`);

    expect(unresolved).toEqual([]);
  });

  it("every environment page has a deeplink name", () => {
    // A segment that resolves bare is a page someone could reasonably want to link to.
    const missing = [...envRouteSegments()]
      .filter((segment) => !NOT_DEEPLINK_NAMES.has(segment))
      .filter((segment) => routeForTarget(segment) && !ENV_PAGE_TARGETS.has(segment))
      .sort();

    expect(missing).toEqual([]);
  });

  it("names whose own segment 404s are redirected, not mapped to themselves", () => {
    // These exist only as the parent of param/child routes, so a bare URL matches no route.
    for (const segment of ["tasks", "waitpoints", "metrics"]) {
      expect(routeForTarget(segment)).toBeUndefined();
    }

    // `tasks` and `waitpoints` therefore point somewhere else; `metrics` is only a legacy redirect
    // shim with no page of its own, so it is deliberately not a deeplink name at all.
    expect(ENV_PAGE_TARGETS.get("tasks")).toBe("");
    expect(ENV_PAGE_TARGETS.get("waitpoints")).toBe("waitpoints/tokens");
    expect(ENV_PAGE_TARGETS.has("metrics")).toBe(false);
  });
});

describe("resolveDeeplinkPage", () => {
  it("maps a bare name to its landing page", () => {
    expect(resolveDeeplinkPage("apikeys")).toBe("apikeys");
    expect(resolveDeeplinkPage("waitpoints")).toBe("waitpoints/tokens");
    expect(resolveDeeplinkPage("tasks")).toBe("");
  });

  it("keeps deeper segments, which address a real sub-route", () => {
    expect(resolveDeeplinkPage("runs/run_123")).toBe("runs/run_123");
    expect(resolveDeeplinkPage("tasks/standard/my-task")).toBe("tasks/standard/my-task");
    expect(resolveDeeplinkPage("waitpoints/tokens")).toBe("waitpoints/tokens");
  });

  it("rejects a name that is not a page", () => {
    expect(resolveDeeplinkPage("")).toBeUndefined();
    expect(resolveDeeplinkPage("nonsense")).toBeUndefined();
    expect(resolveDeeplinkPage("metrics")).toBeUndefined();
  });

  it("drops traversal segments and encodes the rest", () => {
    expect(resolveDeeplinkPage("runs/../../../etc/passwd")).toBe("runs/etc/passwd");
    expect(resolveDeeplinkPage("../runs")).toBe("runs");
    expect(resolveDeeplinkPage("runs/a?b#c")).toBe("runs/a%3Fb%23c");
    expect(resolveDeeplinkPage("runs//run_1")).toBe("runs/run_1");
  });
});
