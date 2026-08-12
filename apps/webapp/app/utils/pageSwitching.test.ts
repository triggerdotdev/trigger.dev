import { flatRoutes } from "@remix-run/dev/dist/config/flat-routes.js";
import type { RouteManifest } from "@remix-run/dev/dist/config/routes.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENT_MATCH_ID,
  ENVIRONMENT_SPECIFIC_PAGES,
  pageBelowEnvironment,
  pagePath,
  pathForEnvironmentSwitch,
  portablePage,
  portablePageSearch,
  PORTABLE_PAGES,
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
    const missing = idFreePages
      .filter((page) => !PORTABLE_PAGES.has(page))
      .filter((page) => !ENVIRONMENT_SPECIFIC_PAGES.includes(page))
      .sort();

    expect(missing).toEqual([]);
  });

  it("all point at a real page", () => {
    const phantom = [...PORTABLE_PAGES].filter((page) => !matchesARoute(page)).sort();

    expect(phantom).toEqual([]);
  });

  it("are all plain relative paths, which is what makes a redirect safe to build from one", () => {
    for (const page of PORTABLE_PAGES) {
      expect(page).toMatch(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/);
    }
  });

  it("each resolve to themselves, so switching twice lands in the same place", () => {
    for (const page of PORTABLE_PAGES) {
      expect(portablePage(page)).toBe(page);
    }
    expect(portablePage("")).toBe("");
  });

  it("include the pages named in the request", () => {
    expect(portablePage("apikeys")).toBe("apikeys");
    expect(portablePage("settings/general")).toBe("settings/general");
    expect(portablePage("waitpoints/tokens")).toBe("waitpoints/tokens");
  });
});

describe("pages named after a resource", () => {
  it("truncate to a list page, id and all, for every one of them", () => {
    const leaked = idPages
      .map((page) => page.replace(/:[^/]+/g, PROBE))
      .filter((page) => {
        const resolved = portablePage(page);
        return resolved.includes(PROBE) || !(resolved === "" || PORTABLE_PAGES.has(resolved));
      })
      .sort();

    expect(leaked).toEqual([]);
  });

  it("truncate to the list they were reached from", () => {
    expect(portablePage("runs/run_123")).toBe("runs");
    expect(portablePage("batches/batch_123")).toBe("batches");
    expect(portablePage("queues/my-queue")).toBe("queues");
    expect(portablePage("schedules/sched_123")).toBe("schedules");
    expect(portablePage("schedules/edit/sched_123")).toBe("schedules");
    expect(portablePage("deployments/deploy_123")).toBe("deployments");
    expect(portablePage("sessions/session_123")).toBe("sessions");
    expect(portablePage("errors/fingerprint_123")).toBe("errors");
    expect(portablePage("bulk-actions/bulk_123")).toBe("bulk-actions");
    expect(portablePage("waitpoints/tokens/waitpoint_123")).toBe("waitpoints/tokens");
    expect(portablePage("dashboards/custom/dashboard_123")).toBe("dashboards");
    expect(portablePage("models/gpt-5")).toBe("models");
    expect(portablePage("prompts/my-prompt")).toBe("prompts");
    expect(portablePage("agents/my-agent")).toBe("agents");
    expect(portablePage("playground/my-agent")).toBe("playground");
    expect(portablePage("test/tasks/my-task")).toBe("test");
    expect(portablePage("runs/run_123/stream")).toBe("runs");
  });

  it("send a task page back to the task list, which is the environment root", () => {
    expect(portablePage("tasks/standard/my-task")).toBe("");
    expect(portablePage("tasks/scheduled/my-task")).toBe("");
  });

  it("keep the built-in metric dashboards but not the one gated per organization", () => {
    expect(portablePage("dashboards/overview")).toBe("dashboards/overview");
    expect(portablePage("dashboards/llm")).toBe("dashboards/llm");
    expect(portablePage("dashboards/queues")).toBe("dashboards");
  });

  it("send the branch lists to the environment root, since the environment type may change", () => {
    expect(portablePage("branches")).toBe("");
    expect(portablePage("dev-branches")).toBe("");
  });
});

describe("a page suffix that is not a plain relative page", () => {
  it("falls back to the environment root rather than being sanitised into one", () => {
    expect(portablePage("/apikeys")).toBe("");
    expect(portablePage("//evil.example.com")).toBe("");
    expect(portablePage("//evil.example.com/apikeys")).toBe("");
    expect(portablePage("https://evil.example.com")).toBe("");
    expect(portablePage("http://evil.example.com/apikeys")).toBe("");
    expect(portablePage("//")).toBe("");
    expect(portablePage("../../login")).toBe("");
    expect(portablePage("..")).toBe("");
    expect(portablePage(".")).toBe("");
    expect(portablePage("%2e%2e/%2e%2e/login")).toBe("");
    expect(portablePage("..%2f..%2flogin")).toBe("");
    expect(portablePage("\\\\evil.example.com")).toBe("");
    expect(portablePage("javascript:alert(1)")).toBe("");
    expect(portablePage("apikeys?next=//evil.example.com")).toBe("");
    expect(portablePage("apikeys#/../..")).toBe("");
    expect(portablePage("nonsense")).toBe("");
    expect(portablePage("")).toBe("");
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
    ];

    for (const attempt of attempts) {
      const resolved = portablePage(attempt);
      expect(resolved === "" || PORTABLE_PAGES.has(resolved)).toBe(true);
    }
  });

  it("does not let a trailing traversal segment change which page is chosen", () => {
    expect(portablePage("apikeys/../../login")).toBe("apikeys");
    expect(portablePage("settings/general/../../..")).toBe("settings/general");
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
