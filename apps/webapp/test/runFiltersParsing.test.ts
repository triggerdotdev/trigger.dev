import { describe, expect, it, vi } from "vitest";

// The function under test gets an injected prisma and store; keep the module singletons from loading.
vi.mock("~/db.server", () => ({}));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));

// Only read when the URL has no rootOnly value.
vi.mock("~/services/preferences/uiPreferences.server", () => ({
  getRootOnlyFilterPreference: async () => false,
}));

import { parseRunFiltersFromSearchParams } from "~/components/runs/v3/RunFilters";
import { getRunFiltersFromRequest, newRunsFilters } from "~/presenters/RunFilters.server";
import {
  convertRunListInputOptionsToFilterRunsOptions,
  parseRunListInputOptions,
} from "~/services/runsRepository/runsRepository.server";

const base = { organizationId: "org", projectId: "proj", environmentId: "env" };
const noDb = {} as never;
const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

function parse(search: string) {
  return parseRunFiltersFromSearchParams(new URLSearchParams(search));
}

describe("parseRunFiltersFromSearchParams", () => {
  // Catches: one bad status wiping every filter, so a bulk action matched all runs
  it("drops only the field that can't be read and reports it", () => {
    const { filters, ignored } = parse("statuses=NOPE&tasks=flaky");

    expect(filters).toEqual({ tasks: ["flaky"] });
    expect(ignored).toEqual([{ key: "statuses", value: "NOPE", reason: "isn't a run status" }]);
  });

  // Catches: SDK status names in a URL being treated as unknown
  it("accepts the SDK's status names as aliases", () => {
    const { filters, ignored } = parse("statuses=FAILED&statuses=queued&statuses=CRASHED");

    expect(filters.statuses).toEqual(["COMPLETED_WITH_ERRORS", "PENDING", "CRASHED"]);
    expect(ignored).toEqual([]);
  });

  it("keeps the good values of a field with one bad value", () => {
    const { filters, ignored } = parse(
      "statuses=FAILED&statuses=NOPE&machines=huge&machines=micro"
    );

    expect(filters.statuses).toEqual(["COMPLETED_WITH_ERRORS"]);
    expect(filters.machines).toEqual(["micro"]);
    expect(ignored.map((i) => `${i.key}:${i.value}`)).toEqual(["statuses:NOPE", "machines:huge"]);
  });

  // Catches: an unreadable period silently selecting all time
  it("reports an unreadable period or timestamp", () => {
    const { filters, ignored } = parse("period=7x&from=abc&tasks=a");

    expect(filters).toEqual({ tasks: ["a"] });
    expect(ignored.map((i) => i.key)).toEqual(["period", "from"]);
  });
});

describe("getRunFiltersFromRequest", () => {
  // Catches: a bulk action started from a list filtered by source (e.g. only scheduled runs)
  // counting, and then canceling or replaying, runs from every source.
  it("carries the source filter into what a bulk action runs with", async () => {
    const filters = await getRunFiltersFromRequest(
      new Request("https://example.com/runs?sources=SCHEDULED&tasks=a")
    );

    // A bulk action stores these filters and parses them back for every batch.
    const stored = parseRunListInputOptions({ ...base, ...filters });
    expect(stored.taskKinds).toEqual(["SCHEDULED"]);
    expect(stored.tasks).toEqual(["a"]);
  });
});

describe("convertRunListInputOptionsToFilterRunsOptions time window", () => {
  it("keeps an explicit period with run IDs", async () => {
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      { ...base, runId: ["run_abc"], period: "1d" },
      noDb,
      noDb
    );

    expect(result.period).toBe(24 * 60 * 60 * 1000);
  });

  it("still applies the 7-day default to filters without run IDs", async () => {
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      { ...base, tasks: ["flaky"] },
      noDb,
      noDb
    );

    expect(result.period).toBe(sevenDaysMs);
  });
});

describe("newRunsFilters", () => {
  // Catches: the "new runs" badge counting runs from every source and region on a filtered list
  it("keeps the source and region filters and starts after the last seen run", async () => {
    const filters = await getRunFiltersFromRequest(
      new Request("http://x/runs?sources=WEBHOOK&regions=eu-central-1&tasks=t&from=1000&cursor=c")
    );
    const options = newRunsFilters(filters, 5000);

    expect(options).toMatchObject({
      taskKinds: ["WEBHOOK"],
      regions: ["eu-central-1"],
      tasks: ["t"],
      from: 5001,
    });
    expect(options).not.toHaveProperty("cursor");
    expect(newRunsFilters({ ...filters, from: 9000 }, 5000).from).toBe(9000);
  });
});
