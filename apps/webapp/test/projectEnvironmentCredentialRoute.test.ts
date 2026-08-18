import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateEnvironmentBootstrapRequest: vi.fn<(...args: any[]) => Promise<any>>(),
  authorizePatEnvironmentAccess: vi.fn<(...args: any[]) => Promise<any>>(),
  authenticatedEnvironmentForAuthentication: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/services/environmentVariableApiAccess.server", () => ({
  authenticateEnvironmentBootstrapRequest: mocks.authenticateEnvironmentBootstrapRequest,
  authorizePatEnvironmentAccess: mocks.authorizePatEnvironmentAccess,
  apiKeyForProjectEnvironmentBootstrap: (authentication: any, rootApiKey: string) =>
    authentication.type === "apiKey" && authentication.result.ok
      ? authentication.result.apiKey
      : rootApiKey,
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticatedEnvironmentForAuthentication: mocks.authenticatedEnvironmentForAuthentication,
  branchNameFromRequest: vi.fn(() => undefined),
}));
vi.mock("~/env.server", () => ({
  env: { API_ORIGIN: "https://api.example.com", APP_ORIGIN: "https://app.example.com" },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { error: vi.fn() },
}));

import { loader } from "~/routes/api.v1.projects.$projectRef.$env";

const environment = {
  id: "env_123",
  apiKey: "tr_prod_root_secret",
  type: "PRODUCTION",
  organizationId: "org_123",
  parentEnvironment: null,
  parentEnvironmentId: null,
  project: {
    id: "proj_123",
    name: "Example project",
    defaultRuntime: "node-24",
  },
};

function load() {
  return loader({
    request: new Request("https://app.example.com/api/v1/projects/proj_ref/prod"),
    params: { projectRef: "proj_ref", env: "prod" },
    context: {},
  });
}

async function responseJson(response: Response) {
  return response.json() as Promise<Record<string, unknown>>;
}

describe("project environment credential response", () => {
  beforeEach(() => {
    mocks.authenticateEnvironmentBootstrapRequest.mockReset();
    mocks.authorizePatEnvironmentAccess.mockReset();
    mocks.authenticatedEnvironmentForAuthentication.mockReset();

    mocks.authorizePatEnvironmentAccess.mockResolvedValue(undefined);
    mocks.authenticatedEnvironmentForAuthentication.mockResolvedValue(environment);
  });

  it("returns the presented API key", async () => {
    mocks.authenticateEnvironmentBootstrapRequest.mockResolvedValue({
      ok: true,
      authentication: {
        type: "apiKey",
        result: {
          ok: true,
          apiKey: "tr_prod_sk_presented",
          type: "PRIVATE",
          environment,
        },
      },
    });

    const response = await load();

    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toMatchObject({
      apiKey: "tr_prod_sk_presented",
      projectId: "proj_123",
      defaultRuntime: "node-24",
    });
    expect(mocks.authorizePatEnvironmentAccess).not.toHaveBeenCalled();
  });

  it("does not exchange a grace-window root key for the current root key", async () => {
    mocks.authenticateEnvironmentBootstrapRequest.mockResolvedValue({
      ok: true,
      authentication: {
        type: "apiKey",
        result: {
          ok: true,
          apiKey: "tr_prod_rotated_grace_key",
          type: "PRIVATE",
          environment,
        },
      },
    });

    const response = await load();

    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toMatchObject({
      apiKey: "tr_prod_rotated_grace_key",
      projectId: "proj_123",
    });
  });

  it("returns the root key to an authorized user token", async () => {
    mocks.authenticateEnvironmentBootstrapRequest.mockResolvedValue({
      ok: true,
      authentication: {
        type: "personalAccessToken",
        result: { userId: "user_123" },
      },
    });

    const response = await load();

    expect(response.status).toBe(200);
    await expect(responseJson(response)).resolves.toMatchObject({
      apiKey: "tr_prod_root_secret",
    });
    expect(mocks.authorizePatEnvironmentAccess).toHaveBeenCalledOnce();
  });
});
