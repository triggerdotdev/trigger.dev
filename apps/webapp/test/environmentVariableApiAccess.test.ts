import { beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn<(...args: any[]) => Promise<any>>(),
  authenticateApiKeyWithScope: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/services/apiAuth.server", () => authMocks);
vi.mock("~/services/rbac.server", () => ({
  rbac: { authenticatePat: vi.fn(), authenticateUserActor: vi.fn() },
}));

import {
  authenticateEnvVarApiRequest,
  presentedApiKeyFromAuthentication,
} from "~/services/environmentVariableApiAccess.server";

describe("presentedApiKeyFromAuthentication", () => {
  it("returns the API key that authenticated the request", () => {
    expect(
      presentedApiKeyFromAuthentication({
        type: "apiKey",
        result: {
          ok: true,
          apiKey: "tr_prod_sk_presented",
          type: "PRIVATE",
          environment: {} as never,
        },
      })
    ).toBe("tr_prod_sk_presented");
  });

  it("does not exchange user tokens for an API key", () => {
    expect(
      presentedApiKeyFromAuthentication({
        type: "personalAccessToken",
        result: { userId: "user_123" } as never,
      })
    ).toBeUndefined();
  });
});

describe("authenticateEnvVarApiRequest", () => {
  beforeEach(() => {
    authMocks.authenticateRequest.mockReset();
    authMocks.authenticateApiKeyWithScope.mockReset();
  });

  it.each([
    { type: "personalAccessToken", result: { userId: "user_123" } },
    { type: "organizationAccessToken", result: { organizationId: "org_123" } },
  ])("preserves $type authentication", async (authentication) => {
    authMocks.authenticateRequest.mockResolvedValue(authentication);
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer token" },
    });

    await expect(authenticateEnvVarApiRequest(request, "read")).resolves.toEqual({
      ok: true,
      authentication,
    });
    expect(authMocks.authenticateRequest).toHaveBeenCalledWith(request, {
      personalAccessToken: true,
      organizationAccessToken: true,
      apiKey: false,
    });
    expect(authMocks.authenticateApiKeyWithScope).not.toHaveBeenCalled();
  });

  it("routes API-key credentials through scoped controller authentication", async () => {
    const authentication = {
      ok: true,
      apiKey: "tr_test_key",
      type: "PRIVATE",
      environment: { id: "env_123" },
      ability: { can: vi.fn(() => true) },
    };
    authMocks.authenticateRequest.mockResolvedValue(undefined);
    authMocks.authenticateApiKeyWithScope.mockResolvedValue({ ok: true, authentication });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_test_key" },
    });

    await expect(authenticateEnvVarApiRequest(request, "write")).resolves.toEqual({
      ok: true,
      authentication: { type: "apiKey", result: authentication },
    });
    expect(authMocks.authenticateApiKeyWithScope).toHaveBeenCalledWith(request, {
      action: "write",
      resource: { type: "envvars" },
    });
  });

  it("preserves scoped controller failures", async () => {
    authMocks.authenticateRequest.mockResolvedValue(undefined);
    authMocks.authenticateApiKeyWithScope.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Unauthorized",
    });

    await expect(
      authenticateEnvVarApiRequest(
        new Request("https://example.com", {
          headers: { Authorization: "Bearer tr_test_key" },
        }),
        "read"
      )
    ).resolves.toEqual({ ok: false, status: 403, error: "Unauthorized" });
  });
});
