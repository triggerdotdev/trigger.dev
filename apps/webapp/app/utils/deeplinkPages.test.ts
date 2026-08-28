import { flatRoutes } from "@remix-run/dev/dist/config/flat-routes.js";
import type { RouteManifest } from "@remix-run/dev/dist/config/routes.js";
import { matchPath } from "@remix-run/router";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEEPLINK_PATH_PREFIX,
  deeplinkSuffix,
  ENV_PAGE_TARGETS,
  ORG_PAGE_TARGETS,
  resolveDeeplinkPage,
  resolveOrganizationDeeplinkPage,
} from "./deeplinkPages";

const APP_DIR = join(__dirname, "..");
const ROUTES_DIR = join(APP_DIR, "routes");

// The trailing dot excludes the environment layout route itself, which has no segment of its own.
const ENV_ROUTE_PREFIX = "_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.";

// Route files that name no deeplink: the environment root, and Remix's layout-opt-out spelling.
const NOT_DEEPLINK_NAMES = new Set(["_index", "queues_"]);

const PROBE = "probe_01ABC";

const DEEPLINK_ROUTE_FILE = "routes/[_].$.ts";

const compiledRoutes: RouteManifest = flatRoutes(APP_DIR, ["**/.*"]);

function compiledUrl(id: string): string {
  if (!compiledRoutes[id]) throw new Error(`no compiled route with id ${id}`);

  const segments: string[] = [];
  let route = compiledRoutes[id];
  while (route) {
    if (route.path) segments.unshift(route.path);
    route = route.parentId ? compiledRoutes[route.parentId] : undefined;
  }
  return `/${segments.join("/")}`;
}

const COMPILED_DEEPLINK_PATH = (() => {
  const entry = Object.values(compiledRoutes).find((route) => route.file === DEEPLINK_ROUTE_FILE);
  if (!entry) throw new Error(`${DEEPLINK_ROUTE_FILE} is not in the compiled route manifest`);
  return compiledUrl(entry.id).replace(/\/\*$/, "");
})();

const routeEntries = readdirSync(ROUTES_DIR);

function isRouteModule(entry: string): boolean {
  const path = join(ROUTES_DIR, entry);
  if (!statSync(path).isDirectory()) return true;
  return existsSync(join(path, "route.tsx")) || existsSync(join(path, "route.ts"));
}

// A trailing `_` only opts out of the parent layout: `queues_.$queueParam` serves `/queues/{id}`.
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

function routeMatches(path: string, { allowParams }: { allowParams: boolean }): boolean {
  const wanted = path === "" ? [] : path.split("/");
  return envRoutes.some(
    (route) =>
      route.length === wanted.length &&
      route.every((segment, i) => (segment.startsWith("$") ? allowParams : segment === wanted[i]))
  );
}

function envRouteSegments(): Set<string> {
  const segments = new Set<string>();
  for (const entry of routeEntries) {
    if (!entry.startsWith(ENV_ROUTE_PREFIX)) continue;
    const segment = entry.slice(ENV_ROUTE_PREFIX.length).split(/[./]/)[0];
    if (!segment || segment === "ts" || segment === "tsx") continue;
    segments.add(segment);
  }
  return segments;
}

function descendantsOf(prefix: string): string[][] {
  const depth = prefix === "" ? 0 : prefix.split("/").length;
  return envRoutes
    .filter((route) => route.length > depth && route.slice(0, depth).join("/") === prefix)
    .map((route) =>
      route.slice(depth).map((segment) => (segment.startsWith("$") ? PROBE : segment))
    );
}

describe("deeplink targets", () => {
  it("read enough routes for the assertions below to mean anything", () => {
    expect(envRouteSegments().size).toBeGreaterThan(20);
    expect(envRoutes.length).toBeGreaterThan(40);
  });

  it("every bare name lands on a real page that needs no id", () => {
    const broken = [...ENV_PAGE_TARGETS.entries()]
      .filter(([name]) => !routeMatches(resolveDeeplinkPage(name) ?? " ", { allowParams: false }))
      .map(([name, { landing }]) => `${name} -> ${landing || "(environment root)"}`);

    expect(broken).toEqual([]);
  });

  it("every deep path lands on a real route, prefix graft included", () => {
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
    expect(descendantsOf("waitpoints/tokens").length).toBeGreaterThan(0);
    expect(descendantsOf("tasks").length).toBeGreaterThan(2);
    expect(descendantsOf("runs").length).toBeGreaterThan(0);
  });

  it("every environment page has a deeplink name", () => {
    const missing = [...envRouteSegments()]
      .filter((segment) => !NOT_DEEPLINK_NAMES.has(segment))
      .filter(
        (segment) => routeMatches(segment, { allowParams: false }) && !ENV_PAGE_TARGETS.has(segment)
      )
      .sort();

    expect(missing).toEqual([]);
  });

  it("points a 404ing name elsewhere, and gives a redirect shim no name at all", () => {
    for (const segment of ["tasks", "waitpoints", "metrics"]) {
      expect(routeMatches(segment, { allowParams: false })).toBe(false);
    }

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

  it("resolves organization-level pages separately from environment pages", () => {
    expect(ORG_PAGE_TARGETS.get("projects")).toEqual({
      landing: "projects",
      prefix: "projects",
    });
    expect(resolveOrganizationDeeplinkPage("projects")).toBe("projects");
    expect(resolveDeeplinkPage("projects")).toBeUndefined();
  });

  it("does not carry a runtime-updates alias", () => {
    expect(ORG_PAGE_TARGETS.has("runtime-updates")).toBe(false);
    expect(resolveOrganizationDeeplinkPage("runtime-updates")).toBeUndefined();
    expect(resolveDeeplinkPage("runtime-updates")).toBeUndefined();
  });

  it("grafts deeper segments onto the prefix", () => {
    expect(resolveDeeplinkPage("runs/run_123")).toBe("runs/run_123");
    expect(resolveDeeplinkPage("tasks/standard/my-task")).toBe("tasks/standard/my-task");
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
    expect(resolveDeeplinkPage("APIKeys")).toBe("apikeys");
    expect(resolveDeeplinkPage("Waitpoints")).toBe("waitpoints/tokens");
    expect(resolveDeeplinkPage("TASKS")).toBe("");
    expect(resolveDeeplinkPage("Bulk-Actions")).toBe("bulk-actions");
    expect(resolveDeeplinkPage("Nonsense")).toBeUndefined();
    expect(resolveDeeplinkPage("Metrics")).toBeUndefined();
  });

  it("leaves the case of everything after the name alone", () => {
    expect(resolveDeeplinkPage("runs/run_ABC123")).toBe("runs/run_ABC123");
    expect(resolveDeeplinkPage("Runs/run_ABC123")).toBe("runs/run_ABC123");
    expect(resolveDeeplinkPage("TASKS/standard/My-Task")).toBe("tasks/standard/My-Task");
    expect(resolveDeeplinkPage("Waitpoints/waitpoint_ABC")).toBe("waitpoints/tokens/waitpoint_ABC");
    expect(resolveDeeplinkPage("Waitpoints/tokens/waitpoint_ABC")).toBe(
      "waitpoints/tokens/waitpoint_ABC"
    );
    expect(resolveDeeplinkPage("Tasks/standard/Group%2FMy-Task")).toBe(
      "tasks/standard/Group%2FMy-Task"
    );
  });

  it("recognises a written-out prefix whatever its case, however many segments it spans", () => {
    expect(resolveDeeplinkPage("Waitpoints/Tokens/wp_123")).toBe("waitpoints/tokens/wp_123");
    expect(resolveDeeplinkPage("waitpoints/Tokens/wp_123")).toBe("waitpoints/tokens/wp_123");
    expect(resolveDeeplinkPage("WAITPOINTS/TOKENS/wp_123")).toBe("waitpoints/tokens/wp_123");
    expect(resolveDeeplinkPage("Waitpoints/Tokens")).toBe("waitpoints/tokens");
  });

  it("holds for every multi-segment prefix in the map, not just waitpoints", () => {
    const multiSegment = [...ENV_PAGE_TARGETS.values()].filter(({ prefix }) =>
      prefix.includes("/")
    );

    expect(multiSegment.length).toBeGreaterThan(0);

    for (const { prefix } of multiSegment) {
      const shouted = prefix
        .split("/")
        .map((segment) => segment.toUpperCase())
        .join("/");
      expect(resolveDeeplinkPage(`${shouted}/${PROBE}`)).toBe(`${prefix}/${PROBE}`);
      expect(resolveDeeplinkPage(shouted)).toBe(prefix);
    }
  });

  it("drops traversal segments, in plain and escaped spellings", () => {
    expect(resolveDeeplinkPage("runs/../../../etc/passwd")).toBe("runs/etc/passwd");
    expect(resolveDeeplinkPage("../runs")).toBe("runs");
    expect(resolveDeeplinkPage("runs//run_1")).toBe("runs/run_1");
    expect(resolveDeeplinkPage("runs/%2e%2e/%2E%2E/run_1")).toBe("runs/run_1");
    expect(resolveDeeplinkPage("runs/%2e/run_1")).toBe("runs/run_1");
    expect(resolveDeeplinkPage("runs/%ZZ/run_1")).toBe("runs/run_1");
  });

  it("passes encoded segments through without re-encoding them", () => {
    expect(resolveDeeplinkPage("tasks/standard/group%2Fmy-task")).toBe(
      "tasks/standard/group%2Fmy-task"
    );
    expect(resolveDeeplinkPage("runs/a%3Fb%23c")).toBe("runs/a%3Fb%23c");
    // The slash stays escaped, so this addresses one odd id rather than climbing out.
    expect(resolveDeeplinkPage("runs/..%2f..%2fetc")).toBe("runs/..%2f..%2fetc");
  });
});

describe("the route Remix compiles from the filename", () => {
  it("mounts the deeplink route at /_ and nowhere else", () => {
    expect(COMPILED_DEEPLINK_PATH).toBe("/_");
    expect(COMPILED_DEEPLINK_PATH).toBe(DEEPLINK_PATH_PREFIX);
  });

  it("does not mount anything as a site-wide splat", () => {
    const siteWide = Object.values(compiledRoutes)
      .filter((route) => compiledUrl(route.id) === "/*")
      .map((route) => route.file);

    expect(siteWide).toEqual([]);
  });

  it("compiled the manifest it is reading, paths and all", () => {
    expect(Object.keys(compiledRoutes).length).toBeGreaterThan(400);
    expect(compiledUrl("routes/login.magic")).toBe("/login/magic");
    expect(
      compiledUrl(
        "routes/_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.queues_.$queueParam"
      )
    ).toBe("/orgs/:organizationSlug/projects/:projectParam/env/:envParam/queues/:queueParam");
  });
});

describe("deeplinkSuffix", () => {
  it("strips the route's own prefix", () => {
    expect(deeplinkSuffix("/_/tasks")).toBe("tasks");
    expect(deeplinkSuffix("/_/runs/run_123")).toBe("runs/run_123");
  });

  it("keeps an escaped slash intact, unlike the decoded splat param", () => {
    expect(deeplinkSuffix("/_/tasks/standard/group%2Fmy-task")).toBe(
      "tasks/standard/group%2Fmy-task"
    );
  });

  it("strips only the prefix, leaving the remainder's case alone", () => {
    expect(deeplinkSuffix("/_/runs/run_ABC123")).toBe("runs/run_ABC123");
    expect(deeplinkSuffix("/_/tasks/standard/My-Task")).toBe("tasks/standard/My-Task");
  });

  it("matches the URL the router serves for it, splat case and all", () => {
    const route = `${COMPILED_DEEPLINK_PATH}/*`;
    expect(matchPath(route, "/_/apikeys")?.params["*"]).toBe("apikeys");
    expect(matchPath(route, "/_/runs/run_123")?.params["*"]).toBe("runs/run_123");
    expect(matchPath(route, "/_/APIKeys")?.params["*"]).toBe("APIKeys");
    expect(matchPath(route, "/deeplink/apikeys")).toBeNull();
    expect(matchPath(route, "/apikeys")).toBeNull();
  });

  it("treats a bare prefix, a trailing slash and anything outside it as no suffix", () => {
    expect(deeplinkSuffix("/_")).toBe("");
    expect(deeplinkSuffix("/_/")).toBe("");
    expect(deeplinkSuffix("/etc")).toBe("");
    expect(deeplinkSuffix("/_app/orgs")).toBe("");
  });

  it("matches what the URL parser actually produces, keeping %2F and resolving %2e%2e", () => {
    const encodedSlash = new URL("http://x/_/tasks/standard/group%2Fmy-task");
    expect(deeplinkSuffix(encodedSlash.pathname)).toBe("tasks/standard/group%2Fmy-task");
    expect(resolveDeeplinkPage(deeplinkSuffix(encodedSlash.pathname))).toBe(
      "tasks/standard/group%2Fmy-task"
    );

    const traversal = new URL("http://x/_/runs/%2e%2e/%2e%2e/etc");
    expect(traversal.pathname).toBe("/etc");
    expect(resolveDeeplinkPage(deeplinkSuffix(traversal.pathname))).toBeUndefined();
  });
});
