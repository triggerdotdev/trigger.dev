import { beforeEach, describe, expect, it, vi } from "vitest";

const rbacMocks = vi.hoisted(() => ({
  authenticateAuthorizeBearer: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/services/rbac.server", () => ({ rbac: rbacMocks }));
vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/models/project.server", () => ({ findProjectByRef: vi.fn() }));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  authIncludeBase: {},
  authIncludeWithParent: {},
  findEnvironmentByApiKey: vi.fn(),
  findEnvironmentByPublicApiKey: vi.fn(),
  toAuthenticated: vi.fn(),
}));
vi.mock("~/services/personalAccessToken.server", () => ({
  authenticateApiRequestWithPersonalAccessToken: vi.fn(),
  isPersonalAccessToken: () => false,
}));
vi.mock("~/services/organizationAccessToken.server", () => ({
  authenticateApiRequestWithOrganizationAccessToken: vi.fn(),
  isOrganizationAccessToken: () => false,
}));
vi.mock("~/services/realtime/jwtAuth.server", () => ({
  isPublicJWT: () => false,
  validatePublicJwtKey: vi.fn(),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";

describe("authenticateApiKeyWithScope", () => {
  beforeEach(() => {
    rbacMocks.authenticateAuthorizeBearer.mockReset();
  });

  it("returns 401 without a bearer credential", async () => {
    const result = await authenticateApiKeyWithScope(new Request("https://example.com"), {
      action: "read",
      resource: { type: "envvars" },
    });

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Invalid or Missing API key",
    });
    expect(rbacMocks.authenticateAuthorizeBearer).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401 as const, error: "Invalid API key" },
    { status: 403 as const, error: "Unauthorized" },
  ])("preserves controller $status failures", async (failure) => {
    rbacMocks.authenticateAuthorizeBearer.mockResolvedValue({ ok: false, ...failure });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_test_key" },
    });

    await expect(
      authenticateApiKeyWithScope(request, {
        action: "write",
        resource: { type: "deployments" },
      })
    ).resolves.toEqual({ ok: false, ...failure });
  });

  it("bridges controller success into the legacy private authentication shape", async () => {
    const environment = { id: "env_123" };
    const ability = { can: vi.fn(() => true), canSuper: vi.fn(() => true) };
    rbacMocks.authenticateAuthorizeBearer.mockResolvedValue({
      ok: true,
      environment,
      ability,
      subject: { type: "apiKey", apiKeyId: "key_123" },
    });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_test_key", "x-trigger-branch": "feature/test" },
    });

    const result = await authenticateApiKeyWithScope(request, {
      action: "read",
      resource: { type: "envvars" },
      allowJWT: true,
    });

    expect(rbacMocks.authenticateAuthorizeBearer).toHaveBeenCalledWith(
      request,
      { action: "read", resource: { type: "envvars" } },
      { allowJWT: true }
    );
    expect(result).toEqual({
      ok: true,
      authentication: {
        ok: true,
        apiKey: "tr_test_key",
        type: "PRIVATE",
        environment,
        ability,
      },
    });
  });
});
