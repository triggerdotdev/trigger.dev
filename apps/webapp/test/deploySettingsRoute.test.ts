import { errAsync, okAsync } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateApiKeyWithScope: vi.fn<(...args: any[]) => Promise<any>>(),
  getDeploySettings: vi.fn<(...args: any[]) => any>(),
}));

vi.mock("~/services/apiAuth.server", () => ({
  authenticateApiKeyWithScope: mocks.authenticateApiKeyWithScope,
}));
vi.mock("~/v3/services/deployment.server", () => ({
  DeploymentService: class {
    getDeploySettings = mocks.getDeploySettings;
  },
}));
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
    mocks.getDeploySettings.mockReset();
    mocks.authenticateApiKeyWithScope.mockResolvedValue({
      ok: true,
      authentication: { environment: environment() },
    });
    mocks.getDeploySettings.mockReturnValue(
      okAsync({ buildPath: "depot", buildPathSource: "default" })
    );
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
    expect(mocks.getDeploySettings).not.toHaveBeenCalled();
  });

  it("maps an environment mismatch to 403", async () => {
    mocks.getDeploySettings.mockReturnValue(errAsync({ type: "environment_mismatch" }));
    const response = await load("prod", "proj_other");
    expect(response.status).toBe(403);
    expect(mocks.getDeploySettings).toHaveBeenCalledWith(environment(), {
      projectRef: "proj_other",
      envSlug: "prod",
    });
  });

  it("returns only the build path, resolved for the authenticated environment", async () => {
    const env = environment({ type: "PREVIEW" });
    mocks.authenticateApiKeyWithScope.mockResolvedValue({
      ok: true,
      authentication: { environment: env },
    });
    mocks.getDeploySettings.mockReturnValue(
      okAsync({ buildPath: "native", buildPathSource: "organization_environment" })
    );

    const response = await load("preview");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ build_path: "native" });
    expect(mocks.getDeploySettings).toHaveBeenCalledWith(env, {
      projectRef: "proj_ref",
      envSlug: "preview",
    });
    expect(mocks.authenticateApiKeyWithScope).toHaveBeenCalledWith(expect.any(Request), {
      action: "read",
      resource: { type: "deployments" },
    });
  });

  it("returns 500 when the global flags cannot be loaded", async () => {
    mocks.getDeploySettings.mockReturnValue(
      errAsync({ type: "failed_to_load_global_flags", cause: new Error("db down") })
    );
    const response = await load();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Internal Server Error" });
  });

  it("rethrows a Response thrown by authentication", async () => {
    const thrown = new Response(null, { status: 429 });
    mocks.authenticateApiKeyWithScope.mockRejectedValue(thrown);
    await expect(load()).rejects.toBe(thrown);
  });
});
