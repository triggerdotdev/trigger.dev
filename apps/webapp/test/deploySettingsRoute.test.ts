import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateApiKeyWithScope: vi.fn<(...args: any[]) => Promise<any>>(),
  findFirst: vi.fn<(...args: any[]) => Promise<any>>(),
  isBillingConfigured: vi.fn<() => boolean>(),
  current: vi.fn<() => Record<string, unknown> | undefined>(),
  flags: vi.fn<() => Promise<Record<string, unknown>>>(),
}));

vi.mock("~/services/apiAuth.server", () => ({
  authenticateApiKeyWithScope: mocks.authenticateApiKeyWithScope,
}));
vi.mock("~/db.server", () => ({ $replica: { project: { findFirst: mocks.findFirst } } }));
vi.mock("~/services/platform.v3.server", () => ({
  isBillingConfigured: mocks.isBillingConfigured,
}));
vi.mock("~/v3/globalFlagsRegistry.server", () => ({
  globalFlagsRegistry: { current: mocks.current },
}));
vi.mock("~/v3/featureFlags.server", () => ({ flags: mocks.flags }));
vi.mock("~/services/logger.server", () => ({
  logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { loader } from "~/routes/api.v1.projects.$projectRef.$env.deploy-settings";

function environment(overrides: Record<string, unknown> = {}) {
  return {
    id: "env_1",
    type: "PRODUCTION",
    project: { id: "proj_1", externalRef: "proj_ref" },
    organization: { featureFlags: {} },
    ...overrides,
  };
}

function load(env = "prod", projectRef = "proj_ref") {
  return loader({
    request: new Request(
      `https://app.example.com/api/v1/projects/${projectRef}/${env}/deploy-settings`
    ),
    params: { projectRef, env },
    context: {},
  });
}

describe("deploy settings route", () => {
  beforeEach(() => {
    mocks.authenticateApiKeyWithScope.mockReset();
    mocks.findFirst.mockReset();
    mocks.isBillingConfigured.mockReset();
    mocks.current.mockReset();
    mocks.flags.mockReset();
    mocks.authenticateApiKeyWithScope.mockResolvedValue({
      ok: true,
      authentication: { environment: environment() },
    });
    mocks.findFirst.mockResolvedValue({ buildSettings: null });
    mocks.isBillingConfigured.mockReturnValue(true);
    mocks.current.mockReturnValue({});
    mocks.flags.mockResolvedValue({});
  });

  it("rejects an unknown env slug before authenticating", async () => {
    const response = await load("nope");
    expect(response.status).toBe(400);
    expect(mocks.authenticateApiKeyWithScope).not.toHaveBeenCalled();
  });

  it("passes the auth failure through", async () => {
    mocks.authenticateApiKeyWithScope.mockResolvedValue({
      ok: false,
      status: 401,
      error: "Invalid API key",
    });
    const response = await load();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Invalid API key" });
  });

  it("refuses a key that belongs to another project or environment type", async () => {
    expect((await load("prod", "proj_other")).status).toBe(403);
    expect((await load("staging")).status).toBe(403);
  });

  it("accepts a preview branch environment on the preview slug", async () => {
    mocks.authenticateApiKeyWithScope.mockResolvedValue({
      ok: true,
      authentication: { environment: environment({ type: "PREVIEW" }) },
    });
    const response = await load("preview");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ build: { path: "depot", source: "default" } });
  });

  it("resolves from the org flags and the registry snapshot without hitting flags()", async () => {
    mocks.authenticateApiKeyWithScope.mockResolvedValue({
      ok: true,
      authentication: {
        environment: environment({
          organization: { featureFlags: { deployBuildPathProduction: "native" } },
        }),
      },
    });
    mocks.current.mockReturnValue({ deployBuildPath: "depot" });
    const response = await load();
    expect(await response.json()).toEqual({
      build: { path: "native", source: "organization_environment" },
    });
    expect(mocks.flags).not.toHaveBeenCalled();
  });

  it("falls back to flags() when the registry is cold", async () => {
    mocks.current.mockReturnValue(undefined);
    mocks.flags.mockResolvedValue({ deployBuildPath: "native" });
    expect(await (await load()).json()).toEqual({ build: { path: "native", source: "global" } });
    expect(mocks.flags).toHaveBeenCalledTimes(1);
  });

  it("honors the project opt-out even when other build settings are malformed", async () => {
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    mocks.findFirst.mockResolvedValue({
      buildSettings: { installCommand: null, disableNativeBuildServer: true },
    });
    expect(await (await load()).json()).toEqual({
      build: { path: "depot", source: "project_opt_out" },
    });
  });

  it("reports native as unavailable without billing", async () => {
    mocks.isBillingConfigured.mockReturnValue(false);
    mocks.current.mockReturnValue({ deployBuildPath: "native" });
    expect(await (await load()).json()).toEqual({
      build: { path: "depot", source: "unavailable" },
    });
  });

  it("returns 500 when the project lookup fails", async () => {
    mocks.findFirst.mockRejectedValue(new Error("db down"));
    const response = await load();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal Server Error" });
  });
});
