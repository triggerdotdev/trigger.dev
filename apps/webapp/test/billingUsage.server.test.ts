import type {
  BillingAddOns,
  BillingMonthlyUsage,
  BillingProjectUsage,
  BillingUsageError,
} from "@trigger.dev/billing";
import { errAsync, okAsync, type ResultAsync } from "neverthrow";
import { describe, expect, it, vi } from "vitest";
import {
  createBillingUsageService,
  type BillingUsageProject,
  type FindBillingUsageProjects,
} from "~/services/billingUsage.server";

const monthlyUsage: BillingMonthlyUsage = {
  organizationId: "org_1",
  fetchedAt: "2026-10-14T12:00:00.000Z",
  month: "2026-10",
  isCurrentMonth: true,
  creditType: { id: "usd", name: "USD (cents)", currency: { code: "USD", minorUnitsPerUnit: 100 } },
  total: 600,
  creditsApplied: 300,
  creditsGranted: 5000,
  credits: [
    {
      id: "com_pro",
      name: "Pro monthly credit",
      kind: "credit",
      amount: 5000,
      applied: 300,
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2026-11-01T00:00:00Z",
    },
  ],
  days: [{ date: "2026-10-13", total: 600 }],
  lines: [],
};

const projectUsage: BillingProjectUsage = {
  organizationId: "org_1",
  fetchedAt: "2026-10-14T12:00:00.000Z",
  month: "2026-10",
  isCurrentMonth: true,
  truncated: false,
  projectIds: ["proj_a", "proj_gone"],
  days: [],
  lines: [],
};

const addOns: BillingAddOns = {
  organizationId: "org_1",
  fetchedAt: "2026-10-14T12:00:00.000Z",
  month: "2026-10",
  creditType: null,
  invoiceDate: "2026-11-01",
  next: [
    {
      productId: "prod_seats",
      name: "Additional Seats",
      quantity: 2,
      unitPrice: 2000,
      total: 4000,
    },
  ],
  charged: [],
};

const projectA: BillingUsageProject = {
  id: "proj_a",
  name: "Alpha",
  slug: "alpha",
  externalRef: "proj_alpharef",
  deleted: false,
};

function controller(
  outcome: {
    monthly?: () => ResultAsync<BillingMonthlyUsage, BillingUsageError>;
    projects?: () => ResultAsync<BillingProjectUsage, BillingUsageError>;
  } = {}
) {
  return {
    getMonthlyUsage: vi.fn(outcome.monthly ?? (() => okAsync(monthlyUsage))),
    getProjectUsage: vi.fn(outcome.projects ?? (() => okAsync(projectUsage))),
    getAddOns: vi.fn(() => okAsync(addOns)),
  };
}

const findNoProjects: FindBillingUsageProjects = async () => [];

describe("createBillingUsageService", () => {
  it("returns the plugin's usage for the requested month", async () => {
    const plugin = controller();
    const service = createBillingUsageService({
      enabled: true,
      controller: plugin,
      findProjects: findNoProjects,
    });

    await expect(service.getMonthlyUsage("org_1", "2026-10")).resolves.toEqual({
      ok: true,
      value: monthlyUsage,
    });
    expect(plugin.getMonthlyUsage).toHaveBeenCalledWith({
      organizationId: "org_1",
      month: "2026-10",
    });
  });

  it("passes loadPending through so a poll fills in the next chunk of days", async () => {
    const plugin = controller();
    const service = createBillingUsageService({
      enabled: true,
      controller: plugin,
      findProjects: findNoProjects,
    });

    await service.getMonthlyUsage("org_1", "2026-10", { loadPending: true });
    await service.getProjectUsage("org_1", "2026-10", { loadPending: true });

    expect(plugin.getMonthlyUsage).toHaveBeenCalledWith({
      organizationId: "org_1",
      month: "2026-10",
      loadPending: true,
    });
    expect(plugin.getProjectUsage).toHaveBeenCalledWith({
      organizationId: "org_1",
      month: "2026-10",
      loadPending: true,
    });
  });

  it("returns the month's add-ons", async () => {
    const service = createBillingUsageService({
      enabled: true,
      controller: controller(),
      findProjects: findNoProjects,
    });

    await expect(service.getAddOns("org_1", "2026-10")).resolves.toEqual({
      ok: true,
      value: addOns,
    });
  });

  it("does not call the plugin when billing v2 is disabled", async () => {
    const plugin = controller();
    const service = createBillingUsageService({
      enabled: false,
      controller: plugin,
      findProjects: findNoProjects,
    });

    await expect(service.getMonthlyUsage("org_1", "2026-10")).resolves.toEqual({
      ok: false,
      error: "feature_disabled",
      retryable: false,
    });
    await expect(service.getProjectUsage("org_1", "2026-10")).resolves.toMatchObject({
      ok: false,
      error: "feature_disabled",
    });
    await expect(service.getAddOns("org_1", "2026-10")).resolves.toMatchObject({
      ok: false,
      error: "feature_disabled",
    });
    expect(plugin.getMonthlyUsage).not.toHaveBeenCalled();
    expect(plugin.getProjectUsage).not.toHaveBeenCalled();
    expect(plugin.getAddOns).not.toHaveBeenCalled();
  });

  it("marks a rate-limited read as retryable", async () => {
    const service = createBillingUsageService({
      enabled: true,
      findProjects: findNoProjects,
      controller: controller({ monthly: () => errAsync("rate_limited") }),
    });

    await expect(service.getMonthlyUsage("org_1", "2026-10")).resolves.toEqual({
      ok: false,
      error: "rate_limited",
      retryable: true,
    });
  });

  it("marks an unknown customer as not retryable", async () => {
    const service = createBillingUsageService({
      enabled: true,
      findProjects: findNoProjects,
      controller: controller({ monthly: () => errAsync("customer_not_found") }),
    });

    await expect(service.getMonthlyUsage("org_1", "2026-10")).resolves.toEqual({
      ok: false,
      error: "customer_not_found",
      retryable: false,
    });
  });

  it("adds the org's projects to project usage", async () => {
    const findProjects = vi.fn<FindBillingUsageProjects>(async () => [projectA]);
    const plugin = controller();
    const service = createBillingUsageService({ enabled: true, controller: plugin, findProjects });

    const result = await service.getProjectUsage("org_1", "2026-10");

    expect(plugin.getProjectUsage).toHaveBeenCalledWith({
      organizationId: "org_1",
      month: "2026-10",
    });
    expect(findProjects).toHaveBeenCalledWith("org_1", ["proj_a", "proj_gone"]);
    expect(result).toEqual({ ok: true, value: { ...projectUsage, projects: [projectA] } });
  });

  it("skips the project lookup when no project has usage", async () => {
    const findProjects = vi.fn<FindBillingUsageProjects>(async () => []);
    const service = createBillingUsageService({
      enabled: true,
      findProjects,
      controller: controller({ projects: () => okAsync({ ...projectUsage, projectIds: [] }) }),
    });

    await expect(service.getProjectUsage("org_1", "2026-10")).resolves.toMatchObject({
      ok: true,
      value: { projects: [] },
    });
    expect(findProjects).not.toHaveBeenCalled();
  });

  it("keeps the usage without project names when the project lookup fails", async () => {
    const service = createBillingUsageService({
      enabled: true,
      controller: controller(),
      findProjects: async () => {
        throw new Error("db down");
      },
    });

    await expect(service.getProjectUsage("org_1", "2026-10")).resolves.toEqual({
      ok: true,
      value: { ...projectUsage, projects: [] },
    });
  });

  it("does not look up projects when the plugin read fails", async () => {
    const findProjects = vi.fn<FindBillingUsageProjects>(async () => []);
    const service = createBillingUsageService({
      enabled: true,
      findProjects,
      controller: controller({ projects: () => errAsync("rate_limited") }),
    });

    await expect(service.getProjectUsage("org_1", "2026-10")).resolves.toEqual({
      ok: false,
      error: "rate_limited",
      retryable: true,
    });
    expect(findProjects).not.toHaveBeenCalled();
  });
});
