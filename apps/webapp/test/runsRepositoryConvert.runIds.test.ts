import { describe, expect, it, vi } from "vitest";

// Prevent run-store / db / env singletons from constructing at import
vi.mock("~/db.server", () => ({}));
vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));
vi.mock("~/env.server", () => ({ env: {} }));

import { convertRunListInputOptionsToFilterRunsOptions } from "~/services/runsRepository/runsRepository.server";

describe("convertRunListInputOptionsToFilterRunsOptions with explicit runIds vs filters (#5110)", () => {
  const mockPrisma = {} as any;
  const mockStore = {} as any;

  it("leaves period undefined when explicit runIds are supplied without time filters", async () => {
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      {
        organizationId: "org_123",
        projectId: "proj_123",
        environmentId: "env_123",
        runId: ["run_recent", "run_older_than_7_days"],
      },
      mockPrisma,
      mockStore
    );

    // Period must remain undefined so runs older than 7 days are not silently excluded (#5110)
    expect(result.period).toBeUndefined();
    expect(result.runId).toEqual(["run_recent", "run_older_than_7_days"]);
  });

  it("applies the default 7d period when no explicit runIds are supplied (filter-only)", async () => {
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      {
        organizationId: "org_123",
        projectId: "proj_123",
        environmentId: "env_123",
        statuses: ["COMPLETED_SUCCESSFULLY"],
      },
      mockPrisma,
      mockStore
    );

    expect(result.period).toBe(7 * 24 * 60 * 60 * 1000); // 604800000 ms
  });

  it("applies the default 7d period when runId is an empty array", async () => {
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      {
        organizationId: "org_123",
        projectId: "proj_123",
        environmentId: "env_123",
        runId: [],
      },
      mockPrisma,
      mockStore
    );

    expect(result.period).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("honors explicit period when supplied alongside runIds", async () => {
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      {
        organizationId: "org_123",
        projectId: "proj_123",
        environmentId: "env_123",
        runId: ["run_1"],
        period: "30d",
      },
      mockPrisma,
      mockStore
    );

    expect(result.period).toBe(30 * 24 * 60 * 60 * 1000);
    expect(result.runId).toEqual(["run_1"]);
  });

  it("honors explicit from/to when supplied alongside runIds without defaulting period", async () => {
    const from = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const to = Date.now();
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      {
        organizationId: "org_123",
        projectId: "proj_123",
        environmentId: "env_123",
        runId: ["run_1"],
        from,
        to,
      },
      mockPrisma,
      mockStore
    );

    expect(result.period).toBeUndefined();
    expect(result.from).toBe(from);
    expect(result.to).toBe(to);
    expect(result.runId).toEqual(["run_1"]);
  });

  it("honors custom period on filter-only queries", async () => {
    const result = await convertRunListInputOptionsToFilterRunsOptions(
      {
        organizationId: "org_123",
        projectId: "proj_123",
        environmentId: "env_123",
        period: "14d",
      },
      mockPrisma,
      mockStore
    );

    expect(result.period).toBe(14 * 24 * 60 * 60 * 1000);
  });
});
