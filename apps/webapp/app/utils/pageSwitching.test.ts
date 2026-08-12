import { flatRoutes } from "@remix-run/dev/dist/config/flat-routes.js";
import type { RouteManifest } from "@remix-run/dev/dist/config/routes.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_MATCH_ID,
  ENVIRONMENT_PORTABLE_PAGES,
  environmentPortablePage,
  pageBelowEnvironment,
  pagePath,
  pathForEnvironmentSwitch,
  portablePageSearch,
  PROJECT_PORTABLE_PAGES,
  PROJECT_SPECIFIC_PAGES,
  projectPortablePage,
  requestedPortablePage,
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

const belowEnvironment = Object.values(compiledRoutes)
  .filter((route) => compiledUrl(route.id).startsWith(ENVIRONMENT_URL))
  .map((route) => ({
    suffix: compiledUrl(route.id).slice(ENVIRONMENT_URL.length).replace(/^\//, ""),
    rendersAPage: rendersAPage(route.file),
  }));

const environmentRoutes = [...new Set(belowEnvironment.map((route) => route.suffix))];

// Streams and Slack callbacks sit below an environment without being pages a user lands on.
const environmentPages = [
  ...new Set(belowEnvironment.filter((route) => route.rendersAPage).map((route) => route.suffix)),
];

const idFreePages = environmentPages.filter((page) => !page.includes(":") && page !== "");
const idPages = environmentPages.filter((page) => page.includes(":"));

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
    expect(environmentPortablePage("")).toBe("");
    expect(projectPortablePage("")).toBe("");
  });

  it("include the pages named in the request", () => {
    expect(projectPortablePage("apikeys")).toBe("apikeys");
    expect(projectPortablePage("settings/general")).toBe("settings/general");
    expect(projectPortablePage("waitpoints/tokens")).toBe("waitpoints/tokens");
  });
});

describe("pages a project or organization switch cannot carry", () => {
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
    expect(requestedPortablePage(new Request("http://localhost/orgs/acme?page=branches"))).toBe("");
    expect(requestedPortablePage(new Request("http://localhost/orgs/acme?page=dev-branches"))).toBe(
      ""
    );
  });
});

describe("pages named after a resource", () => {
  it("truncate to a list page, id and all, for every one of them", () => {
    const leaks = (resolve: (page: string) => string, pages: ReadonlySet<string>) =>
      idPages
        .map((page) => page.replace(/:[^/]+/g, PROBE))
        .filter((page) => {
          const resolved = resolve(page);
          return resolved.includes(PROBE) || !(resolved === "" || pages.has(resolved));
        })
        .sort();

    expect(leaks(environmentPortablePage, ENVIRONMENT_PORTABLE_PAGES)).toEqual([]);
    expect(leaks(projectPortablePage, PROJECT_PORTABLE_PAGES)).toEqual([]);
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

  it("keep the built-in metric dashboards but not the one gated per organization", () => {
    expect(projectPortablePage("dashboards/overview")).toBe("dashboards/overview");
    expect(projectPortablePage("dashboards/llm")).toBe("dashboards/llm");
    expect(projectPortablePage("dashboards/queues")).toBe("dashboards");
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
      requestedPortablePage(new Request(`http://localhost/orgs/acme${search}`));

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
