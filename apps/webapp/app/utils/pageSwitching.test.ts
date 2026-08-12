import { flatRoutes } from "@remix-run/dev/dist/config/flat-routes.js";
import type { RouteManifest } from "@remix-run/dev/dist/config/routes.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { builtInDashboardList } from "../presenters/v3/BuiltInDashboards.server";
import {
  ENVIRONMENT_MATCH_ID,
  ENVIRONMENT_PORTABLE_PAGES,
  environmentPortablePage,
  ORGANIZATION_ADDRESSED_PAGES,
  ORGANIZATION_PORTABLE_PAGES,
  ORGANIZATION_SPECIFIC_PAGES,
  organizationPortablePage,
  pageBelowEnvironment,
  pagePath,
  pathForEnvironmentSwitch,
  portablePageSearch,
  PROJECT_PORTABLE_PAGES,
  PROJECT_SPECIFIC_PAGES,
  projectPortablePage,
  requestedOrganizationPortablePage,
  requestedProjectPortablePage,
  SLUG_ADDRESSED_PAGES,
} from "./pageSwitching";

const APP_DIR = join(__dirname, "..");
const PROBE = "probe_01ABC";

const compiledRoutes: RouteManifest = flatRoutes(APP_DIR, ["**/.*"]);

function compiledUrl(id: string): string {
  let route = compiledRoutes[id];
  if (!route) throw new Error(`no compiled route with id ${id}`);

  const segments: string[] = [];
  while (route) {
    if (route.path) segments.unshift(route.path);
    route = route.parentId ? compiledRoutes[route.parentId] : undefined;
  }
  return `/${segments.join("/")}`;
}

const ENVIRONMENT_URL = compiledUrl(ENVIRONMENT_MATCH_ID);

function rendersAPage(file: string): boolean {
  return /^export default/m.test(readFileSync(join(APP_DIR, file), "utf8"));
}

const ORGANIZATION_GATE = String.raw`(?:can|has)[A-Z]\w*\([^)]*\borganizationSlug\b[^)]*\)`;

const GATE_REJECTS = new RegExp(
  String.raw`if \(\s*(?:(\w+) === "([^"]+)" &&\s*)?!\(await ${ORGANIZATION_GATE}\)\s*\)\s*\{\s*throw`
);

const GATE_REJECTS_VIA_FLAG = new RegExp(
  String.raw`const canAccess = await ${ORGANIZATION_GATE};\s*if \(!canAccess\) \{\s*throw`
);

// A role the caller holds in one organization but not the next: an `authorization` block on the
// loader, or the denial thrown directly for a check the block cannot express.
const GATE_REJECTS_ON_ROLE = /throwPermissionDenied\(|authorization: \{/;

/** The loader's half of a route module, so a gate on its action is not read as a gate on landing. */
function loaderSource(source: string): string {
  const start = source.search(/^export (?:const|async function) loader\b/m);
  if (start < 0) return "";

  const loaderOnwards = source.slice(start);
  const next = loaderOnwards.slice(1).search(/^export (?:const|async function|default)/m);

  return next < 0 ? loaderOnwards : loaderOnwards.slice(0, next + 1);
}

/**
 * The page a loader turns you away from when a check the organization answers says no, whether it
 * sends you home, 404s or renders the permission panel. A gate that only covers one value of a
 * route param names that page; a gate on a route that takes a resource id names nothing, since a
 * page with an id in it is never portable anyway.
 */
function organizationGatedPage(suffix: string, file: string): string | undefined {
  const source = readFileSync(join(APP_DIR, file), "utf8");
  const guarded = GATE_REJECTS.exec(source);

  if (guarded === null) {
    if (GATE_REJECTS_VIA_FLAG.test(source)) return suffix;

    return GATE_REJECTS_ON_ROLE.test(loaderSource(source)) && !suffix.includes(":")
      ? suffix
      : undefined;
  }

  const [, param, key] = guarded;
  if (param === undefined) return suffix.includes(":") ? undefined : suffix;

  return suffix.includes(`:${param}`) ? suffix.replace(`:${param}`, key) : undefined;
}

const belowEnvironment = Object.values(compiledRoutes)
  .filter((route) => compiledUrl(route.id).startsWith(ENVIRONMENT_URL))
  .map((route) => {
    const suffix = compiledUrl(route.id).slice(ENVIRONMENT_URL.length).replace(/^\//, "");
    return {
      suffix,
      file: route.file,
      rendersAPage: rendersAPage(route.file),
      organizationGatedPage: organizationGatedPage(suffix, route.file),
    };
  });

function sourceOf(suffix: string): string {
  const route = belowEnvironment.find((route) => route.suffix === suffix);
  if (!route) throw new Error(`no route below the environment at ${suffix}`);

  return readFileSync(join(APP_DIR, route.file), "utf8");
}

const environmentRoutes = [...new Set(belowEnvironment.map((route) => route.suffix))];

// Streams and Slack callbacks sit below an environment without being pages a user lands on.
const environmentPages = [
  ...new Set(belowEnvironment.filter((route) => route.rendersAPage).map((route) => route.suffix)),
];

const idFreePages = environmentPages.filter((page) => !page.includes(":") && page !== "");
const idPages = environmentPages.filter((page) => page.includes(":"));

const probes = idPages.map((page) => page.replace(/:[^/]+/g, PROBE));

function listAbove(page: string): string {
  return page.slice(0, page.lastIndexOf("/"));
}

const slugAddressedProbes = probes.filter((page) => SLUG_ADDRESSED_PAGES.includes(listAbove(page)));
const organizationAddressedProbes = probes.filter((page) =>
  ORGANIZATION_ADDRESSED_PAGES.includes(listAbove(page))
);
const environmentKeptProbes = [...slugAddressedProbes, ...organizationAddressedProbes];
const idAddressedProbes = probes.filter((page) => !environmentKeptProbes.includes(page));

function matchesARoute(page: string): boolean {
  const wanted = page === "" ? [] : page.split("/");

  return environmentRoutes.some((route) => {
    const segments = route === "" ? [] : route.split("/");
    return (
      segments.length === wanted.length &&
      segments.every((segment, i) => segment.startsWith(":") || segment === wanted[i])
    );
  });
}

const environmentLocation = {
  pathname: "/orgs/acme/projects/api/env/dev",
  search: "",
  hash: "",
};

function locationOn(page: string, search = "", hash = "") {
  return { pathname: pagePath(environmentLocation.pathname, page), search, hash };
}

describe("the environment routes the portable page list is drawn from", () => {
  it("read enough of them for the assertions below to mean anything", () => {
    expect(compiledUrl(ENVIRONMENT_MATCH_ID)).toBe(
      "/orgs/:organizationSlug/projects/:projectParam/env/:envParam"
    );
    expect(idFreePages.length).toBeGreaterThan(20);
    expect(idPages.length).toBeGreaterThan(15);
    expect(environmentPages).toContain("");
  });

  it("asks nothing of the routes that render no page", () => {
    expect(environmentRoutes).toContain("tasks/stream");
    expect(environmentPages).not.toContain("tasks/stream");
    expect(environmentPages).not.toContain("runs/:runParam/stream");
  });
});

describe("portable pages", () => {
  it("cover every environment page that names no resource", () => {
    const missing = idFreePages.filter((page) => !ENVIRONMENT_PORTABLE_PAGES.has(page)).sort();

    expect(missing).toEqual([]);
  });

  it("all point at a real page", () => {
    const phantom = [...ENVIRONMENT_PORTABLE_PAGES].filter((page) => !matchesARoute(page)).sort();

    expect(phantom).toEqual([]);
  });

  it("name every built-in metric dashboard, which the routes cannot tell us since they share one", () => {
    expect(
      [...ENVIRONMENT_PORTABLE_PAGES].filter((page) => page.startsWith("dashboards/")).sort()
    ).toEqual(
      builtInDashboardList()
        .map((dashboard) => `dashboards/${dashboard.key}`)
        .sort()
    );
  });

  it("are all plain relative paths, which is what makes a redirect safe to build from one", () => {
    for (const page of ENVIRONMENT_PORTABLE_PAGES) {
      expect(page).toMatch(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/);
    }
  });

  it("each resolve to themselves, so switching twice lands in the same place", () => {
    for (const page of ENVIRONMENT_PORTABLE_PAGES) {
      expect(environmentPortablePage(page)).toBe(page);
    }
    for (const page of PROJECT_PORTABLE_PAGES) {
      expect(projectPortablePage(page)).toBe(page);
    }
    for (const page of ORGANIZATION_PORTABLE_PAGES) {
      expect(organizationPortablePage(page)).toBe(page);
    }
    expect(environmentPortablePage("")).toBe("");
    expect(projectPortablePage("")).toBe("");
    expect(organizationPortablePage("")).toBe("");
  });

  it("include the pages named in the request", () => {
    expect(projectPortablePage("apikeys")).toBe("apikeys");
    expect(projectPortablePage("settings/general")).toBe("settings/general");
    expect(projectPortablePage("waitpoints/tokens")).toBe("waitpoints/tokens");
  });
});

describe("pages a project switch cannot carry", () => {
  it("are the branch lists, which not every project has", () => {
    expect([...PROJECT_SPECIFIC_PAGES].sort()).toEqual(["branches", "dev-branches"]);

    for (const page of PROJECT_SPECIFIC_PAGES) {
      expect(ENVIRONMENT_PORTABLE_PAGES.has(page)).toBe(true);
      expect(PROJECT_PORTABLE_PAGES.has(page)).toBe(false);
      expect(projectPortablePage(page)).toBe("");
      expect(environmentPortablePage(page)).toBe(page);
    }
  });

  it("are otherwise the same list, so nothing else is quietly dropped", () => {
    const dropped = [...ENVIRONMENT_PORTABLE_PAGES]
      .filter((page) => !PROJECT_PORTABLE_PAGES.has(page))
      .sort();

    expect(dropped).toEqual([...PROJECT_SPECIFIC_PAGES].sort());
  });

  it("stay put when only the environment changes", () => {
    expect(
      pathForEnvironmentSwitch({
        location: locationOn("branches", "?search=feat"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "preview",
      })
    ).toBe("/orgs/acme/projects/api/env/preview/branches?search=feat");

    expect(
      pathForEnvironmentSwitch({
        location: locationOn("dev-branches"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/dev-branches");
  });

  it("fall back to the tasks page when the project changes", () => {
    expect(portablePageSearch(projectPortablePage("branches"))).toBe("");
    expect(portablePageSearch(projectPortablePage("dev-branches"))).toBe("");
    expect(
      requestedProjectPortablePage(new Request("http://localhost/orgs/acme?page=branches"))
    ).toBe("");
    expect(
      requestedProjectPortablePage(new Request("http://localhost/orgs/acme?page=dev-branches"))
    ).toBe("");
  });
});

describe("pages an organization switch cannot carry", () => {
  it("are the ones whose loaders turn you away when the organization is not allowed in", () => {
    const gated = [
      ...new Set(
        belowEnvironment
          .map((route) => route.organizationGatedPage)
          .filter((page): page is string => page !== undefined)
      ),
    ].sort();

    expect(gated).toEqual([...ORGANIZATION_SPECIFIC_PAGES].sort());
  });

  it("are read from every way a loader turns you away, so none stops being noticed", () => {
    const gatedPage = (suffix: string) =>
      belowEnvironment.find((route) => route.suffix === suffix)?.organizationGatedPage;

    expect(gatedPage("logs")).toBe("logs");
    expect(gatedPage("dashboards/:dashboardKey")).toBe("dashboards/queues");
    expect(gatedPage("settings/integrations")).toBe("settings/integrations");
    expect(gatedPage("bulk-actions/:bulkActionParam")).toBeUndefined();
    expect(gatedPage("queues/:queueParam")).toBeUndefined();
    expect(gatedPage("apikeys")).toBeUndefined();
  });

  it("read a role gate off the loader, not off an action the page never runs on landing", () => {
    const gatedAction = [
      "export const loader = dashboardLoader({ params: Schema }, async () => {});",
      "",
      'export const action = dashboardAction({ authorization: { action: "write" } }, async () => {});',
    ].join("\n");

    expect(GATE_REJECTS_ON_ROLE.test(gatedAction)).toBe(true);
    expect(GATE_REJECTS_ON_ROLE.test(loaderSource(gatedAction))).toBe(false);
    expect(GATE_REJECTS_ON_ROLE.test(loaderSource(sourceOf("settings/integrations")))).toBe(true);
  });

  it("still travel with an environment or project switch, which stay in the same organization", () => {
    for (const page of ORGANIZATION_SPECIFIC_PAGES) {
      expect(ENVIRONMENT_PORTABLE_PAGES.has(page)).toBe(true);
      expect(PROJECT_PORTABLE_PAGES.has(page)).toBe(true);
      expect(ORGANIZATION_PORTABLE_PAGES.has(page)).toBe(false);
      expect(environmentPortablePage(page)).toBe(page);
      expect(projectPortablePage(page)).toBe(page);
    }
  });

  it("stay put when only the environment or project changes", () => {
    expect(projectPortablePage("settings/integrations")).toBe("settings/integrations");
    expect(
      pathForEnvironmentSwitch({
        location: locationOn("settings/integrations"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/settings/integrations");

    expect(
      pathForEnvironmentSwitch({
        location: locationOn("dashboards/queues", "?period=1d"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "preview",
      })
    ).toBe("/orgs/acme/projects/api/env/preview/dashboards/queues?period=1d");

    expect(
      pathForEnvironmentSwitch({
        location: locationOn("logs"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/logs");
  });

  it("are otherwise the same list, so nothing else is quietly dropped", () => {
    const dropped = [...PROJECT_PORTABLE_PAGES]
      .filter((page) => !ORGANIZATION_PORTABLE_PAGES.has(page))
      .sort();

    expect(dropped).toEqual([...ORGANIZATION_SPECIFIC_PAGES].sort());
  });

  it("fall back to the nearest page the organization switched into can open", () => {
    const read = (search: string) =>
      requestedOrganizationPortablePage(new Request(`http://localhost/orgs/acme${search}`));

    expect(portablePageSearch(organizationPortablePage("logs"))).toBe("");
    expect(read("?page=logs")).toBe("");
    expect(read("?page=query")).toBe("");
    expect(read("?page=dashboards/queues")).toBe("dashboards");
    expect(read("?page=settings/integrations")).toBe("settings");
    expect(read("?page=apikeys")).toBe("apikeys");
  });
});

describe("pages named after a resource", () => {
  it("truncate to a list page, id and all, for every one of them", () => {
    const leaks = (resolve: (page: string) => string, pages: ReadonlySet<string>, from: string[]) =>
      from
        .filter((page) => {
          const resolved = resolve(page);
          return resolved.includes(PROBE) || !(resolved === "" || pages.has(resolved));
        })
        .sort();

    expect(leaks(environmentPortablePage, ENVIRONMENT_PORTABLE_PAGES, idAddressedProbes)).toEqual(
      []
    );
    expect(leaks(projectPortablePage, PROJECT_PORTABLE_PAGES, probes)).toEqual([]);
    expect(leaks(organizationPortablePage, ORGANIZATION_PORTABLE_PAGES, probes)).toEqual([]);
  });

  it("truncate to the list they were reached from", () => {
    expect(projectPortablePage("runs/run_123")).toBe("runs");
    expect(projectPortablePage("batches/batch_123")).toBe("batches");
    expect(projectPortablePage("queues/my-queue")).toBe("queues");
    expect(projectPortablePage("schedules/sched_123")).toBe("schedules");
    expect(projectPortablePage("schedules/edit/sched_123")).toBe("schedules");
    expect(projectPortablePage("deployments/deploy_123")).toBe("deployments");
    expect(projectPortablePage("sessions/session_123")).toBe("sessions");
    expect(projectPortablePage("errors/fingerprint_123")).toBe("errors");
    expect(projectPortablePage("bulk-actions/bulk_123")).toBe("bulk-actions");
    expect(projectPortablePage("waitpoints/tokens/waitpoint_123")).toBe("waitpoints/tokens");
    expect(projectPortablePage("dashboards/custom/dashboard_123")).toBe("dashboards");
    expect(projectPortablePage("models/gpt-5")).toBe("models");
    expect(projectPortablePage("prompts/my-prompt")).toBe("prompts");
    expect(projectPortablePage("agents/my-agent")).toBe("agents");
    expect(projectPortablePage("playground/my-agent")).toBe("playground");
    expect(projectPortablePage("test/tasks/my-task")).toBe("test");
    expect(projectPortablePage("runs/run_123/stream")).toBe("runs");
  });

  it("send a task page back to the task list, which is the environment root", () => {
    expect(projectPortablePage("tasks/standard/my-task")).toBe("");
    expect(projectPortablePage("tasks/scheduled/my-task")).toBe("");
  });

  it("keep the built-in metric dashboards, which are pages rather than saved dashboards", () => {
    expect(projectPortablePage("dashboards/overview")).toBe("dashboards/overview");
    expect(projectPortablePage("dashboards/llm")).toBe("dashboards/llm");
    expect(projectPortablePage("dashboards/queues")).toBe("dashboards/queues");
  });
});

describe("pages named after something the environment did not issue", () => {
  it("are the ones a route below them takes a code or catalog name for", () => {
    expect([...new Set(slugAddressedProbes.map(listAbove))].sort()).toEqual(
      [...SLUG_ADDRESSED_PAGES].sort()
    );

    for (const page of slugAddressedProbes) {
      expect(environmentPortablePage(page)).toBe(page);
    }
  });

  it("keep their name when only the environment changes, since it names the same thing there", () => {
    const switched = (page: string, search = "") =>
      pathForEnvironmentSwitch({
        location: locationOn(page, search),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      });

    expect(switched("tasks/standard/my-task", "?period=1d")).toBe(
      "/orgs/acme/projects/api/env/prod/tasks/standard/my-task?period=1d"
    );
    expect(switched("tasks/scheduled/my-task")).toBe(
      "/orgs/acme/projects/api/env/prod/tasks/scheduled/my-task"
    );
    expect(switched("test/tasks/my-task")).toBe(
      "/orgs/acme/projects/api/env/prod/test/tasks/my-task"
    );
    expect(switched("agents/my-agent")).toBe("/orgs/acme/projects/api/env/prod/agents/my-agent");
    expect(switched("playground/my-agent")).toBe(
      "/orgs/acme/projects/api/env/prod/playground/my-agent"
    );
    expect(switched("prompts/my-prompt")).toBe(
      "/orgs/acme/projects/api/env/prod/prompts/my-prompt"
    );
    expect(switched("models/gpt-5")).toBe("/orgs/acme/projects/api/env/prod/models/gpt-5");
  });

  it("fall back to their list page when the project or organization changes, which may not have the name", () => {
    expect(projectPortablePage("tasks/standard/my-task")).toBe("");
    expect(projectPortablePage("test/tasks/my-task")).toBe("test");
    expect(projectPortablePage("agents/my-agent")).toBe("agents");
    expect(organizationPortablePage("prompts/my-prompt")).toBe("prompts");
    expect(organizationPortablePage("models/gpt-5")).toBe("models");
  });

  it("keep nothing but a single plain name in that last segment", () => {
    expect(environmentPortablePage("tasks/standard/..%2f..%2flogin")).toBe("");
    expect(environmentPortablePage("tasks/standard/../../login")).toBe("");
    expect(environmentPortablePage("agents/%2e%2e")).toBe("agents");
    expect(environmentPortablePage("agents/..")).toBe("agents");
    expect(environmentPortablePage("agents/%zz")).toBe("agents");
    expect(environmentPortablePage("agents/")).toBe("agents");
    expect(environmentPortablePage("models/my%2Fmodel")).toBe("models");
    expect(environmentPortablePage("prompts/my-prompt/extra")).toBe("prompts");
  });
});

describe("pages named after an id the organization issued", () => {
  it("are the ones a route below them takes an id its organization, not its environment, holds", () => {
    expect(organizationAddressedProbes.length).toBeGreaterThan(0);
    expect([...new Set(organizationAddressedProbes.map(listAbove))].sort()).toEqual(
      [...ORGANIZATION_ADDRESSED_PAGES].sort()
    );

    for (const page of organizationAddressedProbes) {
      expect(environmentPortablePage(page)).toBe(page);
    }
  });

  it("stay open when only the environment changes, since the same id opens them there", () => {
    expect(
      pathForEnvironmentSwitch({
        location: locationOn("dashboards/custom/dashboard_123", "?period=1d"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/dashboards/custom/dashboard_123?period=1d");
  });

  it("fall back to the dashboard list when the project or organization changes", () => {
    expect(projectPortablePage("dashboards/custom/dashboard_123")).toBe("dashboards");
    expect(organizationPortablePage("dashboards/custom/dashboard_123")).toBe("dashboards");
  });

  it("keep nothing but a single plain id in that last segment", () => {
    expect(environmentPortablePage("dashboards/custom/..%2f..%2flogin")).toBe("dashboards");
    expect(environmentPortablePage("dashboards/custom/../../login")).toBe("dashboards");
    expect(environmentPortablePage("dashboards/custom/%2e%2e")).toBe("dashboards");
    expect(environmentPortablePage("dashboards/custom/..")).toBe("dashboards");
    expect(environmentPortablePage("dashboards/custom/")).toBe("dashboards");
    expect(environmentPortablePage("dashboards/custom/dashboard_123/extra")).toBe("dashboards");
  });
});

describe("a page suffix that is not a plain relative page", () => {
  it("falls back to the environment root rather than being sanitised into one", () => {
    expect(projectPortablePage("/apikeys")).toBe("");
    expect(projectPortablePage("//evil.example.com")).toBe("");
    expect(projectPortablePage("//evil.example.com/apikeys")).toBe("");
    expect(projectPortablePage("https://evil.example.com")).toBe("");
    expect(projectPortablePage("http://evil.example.com/apikeys")).toBe("");
    expect(projectPortablePage("//")).toBe("");
    expect(projectPortablePage("../../login")).toBe("");
    expect(projectPortablePage("..")).toBe("");
    expect(projectPortablePage(".")).toBe("");
    expect(projectPortablePage("%2e%2e/%2e%2e/login")).toBe("");
    expect(projectPortablePage("..%2f..%2flogin")).toBe("");
    expect(projectPortablePage("\\\\evil.example.com")).toBe("");
    expect(projectPortablePage("javascript:alert(1)")).toBe("");
    expect(projectPortablePage("apikeys?next=//evil.example.com")).toBe("");
    expect(projectPortablePage("apikeys#/../..")).toBe("");
    expect(projectPortablePage("nonsense")).toBe("");
    expect(projectPortablePage("")).toBe("");
  });

  it("only ever answers with a page it knows, whatever it is handed", () => {
    const attempts = [
      "/apikeys",
      "//evil.example.com",
      "https://evil.example.com/apikeys",
      "../../login",
      "apikeys/../../login",
      "runs/../../../etc/passwd",
      "%2e%2e/apikeys",
      "settings/general/../../..",
      "/branches",
      "..%2fbranches",
      "tasks/standard/../../login",
      "agents/..%2f..%2flogin",
      "models/%2f%2fevil.example.com",
      "dashboards/custom/..%2f..%2flogin",
    ];

    for (const attempt of attempts) {
      expect(
        projectPortablePage(attempt) === "" ||
          PROJECT_PORTABLE_PAGES.has(projectPortablePage(attempt))
      ).toBe(true);
      expect(
        environmentPortablePage(attempt) === "" ||
          ENVIRONMENT_PORTABLE_PAGES.has(environmentPortablePage(attempt))
      ).toBe(true);
      expect(
        organizationPortablePage(attempt) === "" ||
          ORGANIZATION_PORTABLE_PAGES.has(organizationPortablePage(attempt))
      ).toBe(true);
    }
  });

  it("does not let a trailing traversal segment change which page is chosen", () => {
    expect(projectPortablePage("apikeys/../../login")).toBe("apikeys");
    expect(projectPortablePage("settings/general/../../..")).toBe("settings/general");
  });
});

describe("pageBelowEnvironment", () => {
  it("takes the environment prefix off the current path", () => {
    expect(
      pageBelowEnvironment("/orgs/acme/projects/api/env/dev/apikeys", environmentLocation.pathname)
    ).toBe("apikeys");
    expect(
      pageBelowEnvironment("/orgs/acme/projects/api/env/dev", environmentLocation.pathname)
    ).toBe("");
    expect(
      pageBelowEnvironment("/orgs/acme/projects/api/env/dev/", environmentLocation.pathname)
    ).toBe("");
    expect(
      pageBelowEnvironment(
        "/orgs/acme/projects/api/env/dev/runs/run_1",
        environmentLocation.pathname
      )
    ).toBe("runs/run_1");
  });

  it("gives nothing when there is no environment path to take off", () => {
    expect(pageBelowEnvironment("/orgs/acme/projects/api/env/dev/apikeys", undefined)).toBe("");
  });

  it("gives nothing for a path outside the environment", () => {
    expect(pageBelowEnvironment("/account/tokens", environmentLocation.pathname)).toBe("");
    expect(pageBelowEnvironment("/orgs/acme/settings/team", environmentLocation.pathname)).toBe("");
  });

  it("gives nothing when the environment path only prefixes the one in the page path", () => {
    const branch = "/orgs/acme/projects/api/env/preview-feat";

    expect(pageBelowEnvironment(`${branch}-2/runs`, branch)).toBe("");
    expect(pageBelowEnvironment(`${branch}-2`, branch)).toBe("");
    expect(pageBelowEnvironment(`${branch}/runs`, branch)).toBe("runs");
  });
});

describe("pathForEnvironmentSwitch", () => {
  it("keeps every page that only swapping the environment slug used to keep", () => {
    const lost = idFreePages
      .filter(
        (page) =>
          pathForEnvironmentSwitch({
            location: locationOn(page),
            environmentPathname: environmentLocation.pathname,
            environmentSlug: "prod",
          }) !== `/orgs/acme/projects/api/env/prod/${page}`
      )
      .sort();

    expect(lost).toEqual([]);
  });

  it("keeps a portable page, and its filters with it", () => {
    expect(
      pathForEnvironmentSwitch({
        location: locationOn("apikeys"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/apikeys");

    expect(
      pathForEnvironmentSwitch({
        location: locationOn("runs", "?statuses=COMPLETED", "#top"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/runs?statuses=COMPLETED#top");
  });

  it("lands on the environment root when there is no page to keep", () => {
    expect(
      pathForEnvironmentSwitch({
        location: environmentLocation,
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod");
  });

  it("drops the filters along with the id when a page truncates", () => {
    expect(
      pathForEnvironmentSwitch({
        location: locationOn("runs/run_123", "?span=span_1"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/runs");

    expect(
      pathForEnvironmentSwitch({
        location: locationOn("queues/my-queue", "?page=2"),
        environmentPathname: environmentLocation.pathname,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/queues");
  });

  it("only swaps the environment slug when it cannot tell where the environment path ends", () => {
    expect(
      pathForEnvironmentSwitch({
        location: locationOn("apikeys", "?foo=bar"),
        environmentPathname: undefined,
        environmentSlug: "prod",
      })
    ).toBe("/orgs/acme/projects/api/env/prod/apikeys?foo=bar");
  });
});

describe("carrying a page across a project or organization switch", () => {
  it("puts the page in the link, and leaves it out when there is none", () => {
    expect(portablePageSearch("apikeys")).toBe("?page=apikeys");
    expect(portablePageSearch("waitpoints/tokens")).toBe("?page=waitpoints/tokens");
    expect(portablePageSearch("")).toBe("");
  });

  it("reads the page back off the request, validating it again", () => {
    const read = (search: string) =>
      requestedProjectPortablePage(new Request(`http://localhost/orgs/acme${search}`));

    expect(read("?page=apikeys")).toBe("apikeys");
    expect(read("?page=waitpoints/tokens")).toBe("waitpoints/tokens");
    expect(read("?page=runs/run_123")).toBe("runs");
    expect(read("?page=%2f%2fevil.example.com")).toBe("");
    expect(read("?page=https://evil.example.com")).toBe("");
    expect(read("?page=nonsense")).toBe("");
    expect(read("?page=")).toBe("");
    expect(read("")).toBe("");
  });

  it("appends the page to the environment the server picked", () => {
    expect(pagePath("/orgs/acme/projects/web/env/stg", "apikeys")).toBe(
      "/orgs/acme/projects/web/env/stg/apikeys"
    );
    expect(pagePath("/orgs/acme/projects/web/env/stg", "")).toBe("/orgs/acme/projects/web/env/stg");
  });
});
