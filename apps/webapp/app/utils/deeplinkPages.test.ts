import { matchPath } from "@remix-run/router";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEEPLINK_PATH_PREFIX,
  deeplinkSuffix,
  ENV_PAGE_TARGETS,
  resolveDeeplinkPage,
} from "./deeplinkPages";

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

/** Stands in for a param segment, so a deep path under test looks like a real URL. */
const PROBE = "probe_01ABC";

const routeEntries = readdirSync(ROUTES_DIR);

/** A route directory only contributes a route if it actually holds a `route` module. */
function isRouteModule(entry: string): boolean {
  const path = join(ROUTES_DIR, entry);
  if (!statSync(path).isDirectory()) return true;
  return existsSync(join(path, "route.tsx")) || existsSync(join(path, "route.ts"));
}

/**
 * Every environment route as its URL segments. A trailing `_index` is dropped (it supplies the
 * parent's bare URL) and a trailing `_` is trimmed from each segment, because `queues_.$queueParam`
 * serves `/queues/{id}` — the underscore only opts out of the parent layout.
 */
const envRoutes: string[][] = routeEntries
  .filter((entry) => entry.startsWith(ENV_ROUTE_PREFIX) && isRouteModule(entry))
  .map((entry) =>
    entry
      .slice(ENV_ROUTE_PREFIX.length)
      .replace(/\.(tsx|ts)$/, "")
      .split(".")
  )
  .map((segments) => (segments.at(-1) === "_index" ? segments.slice(0, -1) : segments))
  .map((segments) => segments.map((segment) => segment.replace(/_+$/, "")));

/** Does any route match this environment-relative URL? Param segments match the deep case only. */
function routeMatches(path: string, { allowParams }: { allowParams: boolean }): boolean {
  const wanted = path === "" ? [] : path.split("/");
  return envRoutes.some(
    (route) =>
      route.length === wanted.length &&
      route.every((segment, i) => (segment.startsWith("$") ? allowParams : segment === wanted[i]))
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

/**
 * Every route below this prefix, as the segments that follow it, with param segments replaced by a
 * value a real URL would carry. These are the deep links that can actually be made under a name.
 */
function descendantsOf(prefix: string): string[][] {
  const depth = prefix === "" ? 0 : prefix.split("/").length;
  return envRoutes
    .filter((route) => route.length > depth && route.slice(0, depth).join("/") === prefix)
    .map((route) =>
      route.slice(depth).map((segment) => (segment.startsWith("$") ? PROBE : segment))
    );
}

describe("deeplink targets", () => {
  it("found the routes directory", () => {
    // Without this, every assertion below would pass vacuously if the glob ever broke.
    expect(envRouteSegments().size).toBeGreaterThan(20);
    expect(envRoutes.length).toBeGreaterThan(40);
  });

  it("every bare name lands on a real page", () => {
    // A landing page is a page you arrive at with no id, so a param route does not count.
    const broken = [...ENV_PAGE_TARGETS.entries()]
      .filter(([name]) => !routeMatches(resolveDeeplinkPage(name) ?? " ", { allowParams: false }))
      .map(([name, { landing }]) => `${name} -> ${landing || "(environment root)"}`);

    expect(broken).toEqual([]);
  });

  it("every deep path lands on a real route", () => {
    // The invariant a bare segment list could not express: /deeplink/waitpoints/{id} has to reach
    // waitpoints/tokens/{id}, not waitpoints/{id}. Driven off the real child routes rather than one
    // synthetic segment, so names whose children are all literal (settings/general) count too.
    const broken: string[] = [];

    for (const [name, { prefix }] of ENV_PAGE_TARGETS) {
      for (const rest of descendantsOf(prefix)) {
        const suffix = [name, ...rest].join("/");
        const resolved = resolveDeeplinkPage(suffix);
        if (!routeMatches(resolved ?? " ", { allowParams: true })) {
          broken.push(`${suffix} -> ${resolved}`);
        }
      }
    }

    expect(broken).toEqual([]);
  });

  it("has deep paths worth checking", () => {
    // Keeps the assertion above from passing because it iterated nothing.
    expect(descendantsOf("waitpoints/tokens").length).toBeGreaterThan(0);
    expect(descendantsOf("tasks").length).toBeGreaterThan(2);
    expect(descendantsOf("runs").length).toBeGreaterThan(0);
  });

  it("every environment page has a deeplink name", () => {
    // A segment that resolves bare is a page someone could reasonably want to link to.
    const missing = [...envRouteSegments()]
      .filter((segment) => !NOT_DEEPLINK_NAMES.has(segment))
      .filter(
        (segment) => routeMatches(segment, { allowParams: false }) && !ENV_PAGE_TARGETS.has(segment)
      )
      .sort();

    expect(missing).toEqual([]);
  });

  it("names whose own segment 404s are redirected, not mapped to themselves", () => {
    // These exist only as the parent of param/child routes, so a bare URL matches no route.
    for (const segment of ["tasks", "waitpoints", "metrics"]) {
      expect(routeMatches(segment, { allowParams: false })).toBe(false);
    }

    // `tasks` and `waitpoints` therefore point elsewhere; `metrics` is only a legacy redirect shim
    // with no page of its own, so it is deliberately not a deeplink name at all.
    expect(ENV_PAGE_TARGETS.get("tasks")).toEqual({ landing: "", prefix: "tasks" });
    expect(ENV_PAGE_TARGETS.get("waitpoints")).toEqual({
      landing: "waitpoints/tokens",
      prefix: "waitpoints/tokens",
    });
    expect(ENV_PAGE_TARGETS.has("metrics")).toBe(false);
  });
});

describe("resolveDeeplinkPage", () => {
  it("maps a bare name to its landing page", () => {
    expect(resolveDeeplinkPage("apikeys")).toBe("apikeys");
    expect(resolveDeeplinkPage("waitpoints")).toBe("waitpoints/tokens");
    expect(resolveDeeplinkPage("tasks")).toBe("");
  });

  it("grafts deeper segments onto the prefix", () => {
    expect(resolveDeeplinkPage("runs/run_123")).toBe("runs/run_123");
    // The landing is the environment root, but task detail still lives under /tasks.
    expect(resolveDeeplinkPage("tasks/standard/my-task")).toBe("tasks/standard/my-task");
    // The prefix supplies the `tokens` segment the caller did not have to know about.
    expect(resolveDeeplinkPage("waitpoints/waitpoint_123")).toBe("waitpoints/tokens/waitpoint_123");
  });

  it("does not duplicate a prefix the caller already wrote out", () => {
    expect(resolveDeeplinkPage("waitpoints/tokens")).toBe("waitpoints/tokens");
    expect(resolveDeeplinkPage("waitpoints/tokens/waitpoint_123")).toBe(
      "waitpoints/tokens/waitpoint_123"
    );
  });

  it("rejects a name that is not a page", () => {
    expect(resolveDeeplinkPage("")).toBeUndefined();
    expect(resolveDeeplinkPage("nonsense")).toBeUndefined();
    expect(resolveDeeplinkPage("metrics")).toBeUndefined();
  });

  it("matches the page name whatever its case, and resolves it to the map's spelling", () => {
    // `/env/{env}/APIKeys` matches its route, so the short link has to agree rather than falling
    // through to the environment root.
    expect(resolveDeeplinkPage("APIKeys")).toBe("apikeys");
    expect(resolveDeeplinkPage("Waitpoints")).toBe("waitpoints/tokens");
    expect(resolveDeeplinkPage("TASKS")).toBe("");
    expect(resolveDeeplinkPage("Bulk-Actions")).toBe("bulk-actions");
    // Case doesn't turn a non-page into a page.
    expect(resolveDeeplinkPage("Nonsense")).toBeUndefined();
    expect(resolveDeeplinkPage("Metrics")).toBeUndefined();
  });

  it("leaves the case of everything after the name alone", () => {
    // Only the name is folded. Ids are case-sensitive, so lowercasing one would break the link far
    // more thoroughly than the miss the folding fixes.
    expect(resolveDeeplinkPage("runs/run_ABC123")).toBe("runs/run_ABC123");
    expect(resolveDeeplinkPage("Runs/run_ABC123")).toBe("runs/run_ABC123");
    expect(resolveDeeplinkPage("TASKS/standard/My-Task")).toBe("tasks/standard/My-Task");
    // Grafted onto the prefix and already written out under it, both with the id untouched.
    expect(resolveDeeplinkPage("Waitpoints/waitpoint_ABC")).toBe("waitpoints/tokens/waitpoint_ABC");
    expect(resolveDeeplinkPage("Waitpoints/tokens/waitpoint_ABC")).toBe(
      "waitpoints/tokens/waitpoint_ABC"
    );
    // An escaped slash inside a capitalised id survives as one segment, as it does in lower case.
    expect(resolveDeeplinkPage("Tasks/standard/Group%2FMy-Task")).toBe(
      "tasks/standard/Group%2FMy-Task"
    );
  });

  it("drops traversal segments, in plain and escaped spellings", () => {
    expect(resolveDeeplinkPage("runs/../../../etc/passwd")).toBe("runs/etc/passwd");
    expect(resolveDeeplinkPage("../runs")).toBe("runs");
    expect(resolveDeeplinkPage("runs//run_1")).toBe("runs/run_1");
    // `%2e%2e` decodes to `..`, so it has to be rejected in the encoded form too.
    expect(resolveDeeplinkPage("runs/%2e%2e/%2E%2E/run_1")).toBe("runs/run_1");
    expect(resolveDeeplinkPage("runs/%2e/run_1")).toBe("runs/run_1");
    // A malformed escape can't be part of a URL we build.
    expect(resolveDeeplinkPage("runs/%ZZ/run_1")).toBe("runs/run_1");
  });

  it("passes encoded segments through without re-encoding them", () => {
    // The dashboard writes a task id containing a slash this way, so it must survive as one
    // segment rather than being split or double-encoded into %252F.
    expect(resolveDeeplinkPage("tasks/standard/group%2Fmy-task")).toBe(
      "tasks/standard/group%2Fmy-task"
    );
    expect(resolveDeeplinkPage("runs/a%3Fb%23c")).toBe("runs/a%3Fb%23c");
    // An escaped slash stays escaped, so this addresses one odd id rather than climbing out.
    expect(resolveDeeplinkPage("runs/..%2f..%2fetc")).toBe("runs/..%2f..%2fetc");
  });
});

describe("deeplinkSuffix", () => {
  it("strips the route's own prefix", () => {
    expect(deeplinkSuffix("/deeplink/tasks")).toBe("tasks");
    expect(deeplinkSuffix("/deeplink/runs/run_123")).toBe("runs/run_123");
  });

  it("keeps an escaped slash intact, unlike the decoded splat param", () => {
    expect(deeplinkSuffix("/deeplink/tasks/standard/group%2Fmy-task")).toBe(
      "tasks/standard/group%2Fmy-task"
    );
  });

  it("strips the prefix whatever its case, and only the prefix", () => {
    expect(deeplinkSuffix("/Deeplink/apikeys")).toBe("apikeys");
    expect(deeplinkSuffix("/DEEPLINK/runs/run_ABC123")).toBe("runs/run_ABC123");
    // The remainder comes back as it was written, capitals and all.
    expect(deeplinkSuffix("/DeepLink/tasks/standard/My-Task")).toBe("tasks/standard/My-Task");
    expect(deeplinkSuffix("/Deeplink")).toBe("");
    expect(deeplinkSuffix("/Deeplink/")).toBe("");
  });

  it("folds case because the route it is mounted on does", () => {
    // The assertion the test above rests on: React Router compiles a route path with the `i` flag
    // unless it opts into `caseSensitive`, so a capitalised prefix really does reach this loader
    // instead of 404ing before it. If that ever changed, the folding would be dead weight.
    const route = `${DEEPLINK_PATH_PREFIX}/*`;
    expect(matchPath(route, "/deeplink/apikeys")?.params["*"]).toBe("apikeys");
    expect(matchPath(route, "/Deeplink/apikeys")?.params["*"]).toBe("apikeys");
    // And the splat keeps the case it was given, which is why only the first segment is folded.
    expect(matchPath(route, "/DEEPLINK/APIKeys")?.params["*"]).toBe("APIKeys");
  });

  it("treats a bare prefix, a trailing slash and anything outside it as no suffix", () => {
    expect(deeplinkSuffix("/deeplink")).toBe("");
    expect(deeplinkSuffix("/deeplink/")).toBe("");
    // What `new URL` leaves behind once it has normalised and resolved `%2e%2e` itself.
    expect(deeplinkSuffix("/etc")).toBe("");
  });

  it("matches what the URL parser actually produces", () => {
    // The behaviour above is only correct if `new URL` really does keep %2F and really does
    // resolve %2e%2e, so assert that rather than assuming it.
    const encodedSlash = new URL("http://x/deeplink/tasks/standard/group%2Fmy-task");
    expect(deeplinkSuffix(encodedSlash.pathname)).toBe("tasks/standard/group%2Fmy-task");
    expect(resolveDeeplinkPage(deeplinkSuffix(encodedSlash.pathname))).toBe(
      "tasks/standard/group%2Fmy-task"
    );

    // `%2e%2e` is normalised to `..` and resolved by the parser, leaving the prefix behind.
    const traversal = new URL("http://x/deeplink/runs/%2e%2e/%2e%2e/etc");
    expect(traversal.pathname).toBe("/etc");
    expect(resolveDeeplinkPage(deeplinkSuffix(traversal.pathname))).toBeUndefined();
  });
});
