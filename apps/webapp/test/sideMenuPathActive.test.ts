import { describe, expect, it } from "vitest";
import { isSideMenuPathActive } from "~/components/navigation/SideMenuItem";

describe("isSideMenuPathActive", () => {
  // Catches: prefix-matched items losing active state on detail pages or matching sibling routes with a shared prefix
  it("matches exact paths and sub-paths on a '/' boundary without bleeding into sibling routes", () => {
    const to = "/orgs/org-1/projects/proj-1/env/dev/concurrency";

    expect(isSideMenuPathActive({ pathName: to, to, matchPrefix: true })).toBe(true);
    expect(isSideMenuPathActive({ pathName: `${to}/queues`, to, matchPrefix: true })).toBe(true);
    expect(
      isSideMenuPathActive({
        pathName: "/orgs/org-1/projects/proj-1/env/dev/concurrency-limits",
        to,
        matchPrefix: true,
      })
    ).toBe(false);
    expect(isSideMenuPathActive({ pathName: `${to}/queues`, to, matchPrefix: false })).toBe(false);
  });

  // Catches: Tasks activePathPrefix failing to match task, agent, and schedule detail pages or matching unrelated env sections
  it("matches Tasks across its dedicated sub-path prefixes without matching sibling environment routes", () => {
    const envPath = "/orgs/org-1/projects/proj-1/env/dev";
    const activePathPrefix = [`${envPath}/tasks`, `${envPath}/agents`, `${envPath}/schedules`];

    expect(isSideMenuPathActive({ pathName: envPath, to: envPath, activePathPrefix })).toBe(true);
    expect(
      isSideMenuPathActive({
        pathName: `${envPath}/tasks/standard/my-task`,
        to: envPath,
        activePathPrefix,
      })
    ).toBe(true);
    expect(
      isSideMenuPathActive({
        pathName: `${envPath}/agents/my-agent`,
        to: envPath,
        activePathPrefix,
      })
    ).toBe(true);
    expect(
      isSideMenuPathActive({
        pathName: `${envPath}/schedules/sched_123`,
        to: envPath,
        activePathPrefix,
      })
    ).toBe(true);

    expect(
      isSideMenuPathActive({
        pathName: `${envPath}/runs/run_123`,
        to: envPath,
        activePathPrefix,
      })
    ).toBe(false);
    expect(
      isSideMenuPathActive({
        pathName: `${envPath}/webhooks/wh_123`,
        to: envPath,
        activePathPrefix,
      })
    ).toBe(false);
  });

  // Catches: root "/" or trailing-slash prefixes matching unrelated routes or failing to match exact normalized paths
  it("ignores empty or root prefixes while normalizing trailing slashes", () => {
    expect(isSideMenuPathActive({ pathName: "/orgs/org-1", to: "/", matchPrefix: true })).toBe(
      false
    );
    expect(
      isSideMenuPathActive({
        pathName: "/orgs/org-1/settings/private-connections",
        to: "/orgs/org-1/settings/private-connections/",
        matchPrefix: true,
      })
    ).toBe(true);
    expect(
      isSideMenuPathActive({
        pathName: "/orgs/org-1/settings/private-connections/new",
        to: "/orgs/org-1/settings/private-connections/",
        matchPrefix: true,
      })
    ).toBe(true);
  });
});
