import { describe, expect, it } from "vitest";
import {
  ALL_PROJECTS,
  parseUsagePageState,
  pendingUsageDays,
  pendingUsageFetches,
  shouldPollUsage,
  shouldReloadUsage,
  storedGroupingsToRestore,
  writeStoredGroupings,
  type GroupingsStore,
} from "./billingUsagePageState";

describe("parseUsagePageState", () => {
  it("defaults to the usage tab, the default groupings, all projects, compute time and ms", () => {
    expect(parseUsagePageState(new URLSearchParams(), [])).toEqual({
      tab: "usage",
      usageGroupings: ["region", "machine", "usageType"],
      projectGroupings: ["project", "region", "machine"],
      project: ALL_PROJECTS,
      metric: "computeMs",
      timeFormat: "ms",
    });
  });

  it("reads each tab's own grouping order and the project tab's switches", () => {
    const state = parseUsagePageState(
      new URLSearchParams(
        "tab=projects&groups=region,usageType&projectGroups=environment,project&project=proj_1&metric=runs&time=readable"
      ),
      ["proj_1"]
    );

    expect(state).toEqual({
      tab: "projects",
      usageGroupings: ["region", "usageType"],
      projectGroupings: ["environment", "project"],
      project: "proj_1",
      metric: "runs",
      timeFormat: "readable",
    });
  });

  it("falls back to all projects for a project the org does not have", () => {
    expect(parseUsagePageState(new URLSearchParams("project=other"), ["proj_1"]).project).toBe(
      ALL_PROJECTS
    );
  });

  it("ignores unknown tab, metric and time values", () => {
    const state = parseUsagePageState(new URLSearchParams("tab=x&metric=x&time=x"), []);

    expect([state.tab, state.metric, state.timeFormat]).toEqual(["usage", "computeMs", "ms"]);
  });
});

describe("shouldReloadUsage", () => {
  const page = "https://app.test/orgs/acme/settings/billing-usage";
  const url = (search: string) => new URL(`${page}${search}`);

  it("reloads when the month changes", () => {
    expect(shouldReloadUsage(url("?month=2026-10"), url("?month=2026-09&tab=usage"))).toBe(true);
  });

  it("keeps the loaded data when only the tab, groupings or switches change", () => {
    expect(shouldReloadUsage(url("?month=2026-10"), url("?month=2026-10&tab=projects"))).toBe(
      false
    );
    expect(shouldReloadUsage(url("?groups=machine"), url("?groups=region"))).toBe(false);
  });

  it("defers to Remix for a retry on the same URL or another page", () => {
    expect(shouldReloadUsage(url("?month=2026-10"), url("?month=2026-10"))).toBeUndefined();
    expect(
      shouldReloadUsage(url(""), new URL("https://app.test/orgs/acme/settings"))
    ).toBeUndefined();
  });
});

function memoryStore(initial: Record<string, string> = {}): GroupingsStore & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("remembered groupings", () => {
  it("writes each tab's order under its own key", () => {
    const store = memoryStore();

    writeStoredGroupings(store, "usageGroupings", ["machine", "region"]);
    writeStoredGroupings(store, "projectGroupings", ["project", "environment"]);

    expect(Object.fromEntries(store.values)).toEqual({
      "tdev:billing-usage:groups": "machine,region",
      "tdev:billing-usage:projectGroups": "project,environment",
    });
  });

  it("restores stored groupings for tabs the URL does not set", () => {
    const store = memoryStore({
      "tdev:billing-usage:groups": "environment,usageType",
      "tdev:billing-usage:projectGroups": "project,region",
    });

    expect(storedGroupingsToRestore(new URLSearchParams("projectGroups=machine"), store)).toEqual({
      groups: "environment,usageType",
    });
  });

  it("drops stale values on restore instead of breaking the page", () => {
    const store = memoryStore({ "tdev:billing-usage:groups": "bogus,region,project" });

    expect(storedGroupingsToRestore(new URLSearchParams(), store)).toEqual({ groups: "region" });
  });

  it("restores nothing without storage, or when storage throws", () => {
    const throwing: GroupingsStore = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };

    expect(storedGroupingsToRestore(new URLSearchParams(), undefined)).toEqual({});
    expect(storedGroupingsToRestore(new URLSearchParams(), throwing)).toEqual({});
    expect(() => writeStoredGroupings(throwing, "usageGroupings", ["region"])).not.toThrow();
  });
});

describe("usage tabs and polling", () => {
  it("opens the add-ons tab and falls back to usage for an unknown tab", () => {
    expect(parseUsagePageState(new URLSearchParams("tab=addons"), []).tab).toBe("addons");
    expect(parseUsagePageState(new URLSearchParams("tab=nope"), []).tab).toBe("usage");
  });

  it("counts each pending day once across the reads that succeeded", () => {
    const reads = [
      { ok: true, value: { pendingDays: 24 } },
      { ok: true, value: { pendingDays: 24 } },
      { ok: false },
    ] as const;
    expect(pendingUsageDays(...reads)).toBe(24);
    expect(pendingUsageDays({ ok: true, value: {} })).toBe(0);
    expect(pendingUsageDays({ ok: false })).toBe(0);
  });

  it("sums pending days per read to tell when a poll made progress", () => {
    expect(
      pendingUsageFetches(
        { ok: true, value: { pendingDays: 4 } },
        { ok: true, value: { pendingDays: 11 } }
      )
    ).toBe(15);
  });

  it("polls while days are pending and the last poll made progress", () => {
    expect(shouldPollUsage(11, undefined)).toBe(true);
    expect(shouldPollUsage(4, 11)).toBe(true);
    expect(shouldPollUsage(4, 4)).toBe(false);
    expect(shouldPollUsage(0, 4)).toBe(false);
  });
});
