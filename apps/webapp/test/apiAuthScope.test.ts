import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateApiKeyRequest,
  authenticateApiKeyWithScope,
  authenticateRequestWithScopedApiKey,
} from "~/services/apiAuth.server";

const authorizeBearer = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
});

describe("authenticateApiKeyWithScope", () => {
  it("returns 401 without a bearer credential", async () => {
    const result = await authenticateApiKeyWithScope(
      new Request("https://example.com"),
      { action: "read", resource: { type: "envvars" } },
      authorizeBearer
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "Invalid or Missing API key",
    });
    expect(authorizeBearer).not.toHaveBeenCalled();
  });

  it.each([
    { status: 401 as const, error: "Invalid API key" },
    { status: 403 as const, error: "Unauthorized" },
  ])("preserves controller $status failures", async (failure) => {
    authorizeBearer.mockResolvedValueOnce({ ok: false, ...failure });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_test_key" },
    });

    await expect(
      authenticateApiKeyWithScope(
        request,
        { action: "write", resource: { type: "deployments" } },
        authorizeBearer
      )
    ).resolves.toEqual({ ok: false, ...failure });
  });

  it("bridges controller success into the legacy private authentication shape", async () => {
    const environment = { id: "env_123" };
    const ability = { can: vi.fn(() => true), canSuper: vi.fn(() => true) };
    authorizeBearer.mockResolvedValueOnce({
      ok: true,
      environment,
      ability,
      subject: { type: "apiKey", apiKeyId: "key_123" },
    });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_test_key" },
    });

    const result = await authenticateApiKeyWithScope(
      request,
      { action: "read", resource: { type: "envvars" }, allowJWT: true },
      authorizeBearer
    );

    expect(authorizeBearer).toHaveBeenCalledWith(
      request,
      { action: "read", resource: { type: "envvars" } },
      { allowJWT: true, allowPreviewParent: false }
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

  it("allows branch creation to authenticate against the Preview parent", async () => {
    const environment = { id: "env_preview" };
    const ability = { can: vi.fn(() => true), canSuper: vi.fn(() => true) };
    authorizeBearer.mockResolvedValueOnce({
      ok: true,
      environment,
      ability,
      subject: { type: "apiKey", apiKeyId: "key_123" },
    });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_preview_sk_test" },
    });

    await expect(
      authenticateApiKeyWithScope(
        request,
        {
          action: "write",
          resource: { type: "branches" },
          allowPreviewParent: true,
        },
        authorizeBearer
      )
    ).resolves.toMatchObject({ ok: true });
    expect(authorizeBearer).toHaveBeenCalledWith(
      request,
      { action: "write", resource: { type: "branches" } },
      { allowJWT: false, allowPreviewParent: true }
    );
  });

  it("authenticates a valid API key without a resource check", async () => {
    const environment = { id: "env_123" };
    const ability = { can: vi.fn(() => false), canSuper: vi.fn(() => false) };
    const authenticateBearer = vi.fn().mockResolvedValueOnce({
      ok: true,
      environment,
      ability,
      subject: { type: "apiKey", apiKeyId: "key_123" },
    });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_prod_sk_test" },
    });

    await expect(
      authenticateApiKeyRequest(request, { allowPreviewParent: true }, authenticateBearer)
    ).resolves.toMatchObject({
      ok: true,
      authentication: { apiKey: "tr_prod_sk_test", environment },
    });
    expect(ability.can).not.toHaveBeenCalled();
  });

  it("returns authorization failures from the controller", async () => {
    const ability = { can: vi.fn(() => false), canSuper: vi.fn(() => false) };
    authorizeBearer.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Unauthorized",
    });
    const request = new Request("https://example.com", {
      headers: { Authorization: "Bearer tr_prod_sk_test" },
    });

    await expect(
      authenticateApiKeyWithScope(
        request,
        { action: "write", resource: { type: "deployments" } },
        authorizeBearer
      )
    ).resolves.toEqual({ ok: false, status: 403, error: "Unauthorized" });
    expect(ability.can).not.toHaveBeenCalled();
  });
});

describe("authenticateRequestWithScopedApiKey", () => {
  const options = {
    personalAccessToken: true as const,
    organizationAccessToken: true as const,
    apiKey: {
      action: "write",
      resource: { type: "branches" },
      allowPreviewParent: true,
    },
  };

  it("keeps user and organization tokens on the legacy path", async () => {
    const authentication = {
      type: "personalAccessToken",
      result: { userId: "user_123" },
    } as const;
    const authenticateRequest = vi.fn().mockResolvedValueOnce(authentication);
    const authenticateApiKeyWithScope = vi.fn();

    await expect(
      authenticateRequestWithScopedApiKey(new Request("https://example.com"), options, {
        authenticateRequest,
        authenticateApiKeyWithScope,
      })
    ).resolves.toEqual({ ok: true, authentication });
    expect(authenticateRequest).toHaveBeenCalledWith(expect.any(Request), {
      personalAccessToken: true,
      organizationAccessToken: true,
      apiKey: false,
    });
    expect(authenticateApiKeyWithScope).not.toHaveBeenCalled();
  });

  it("uses scoped RBAC authentication for API keys", async () => {
    const apiKeyAuthentication = {
      ok: true,
      apiKey: "tr_preview_sk_test",
      type: "PRIVATE",
      environment: {},
    } as const;
    const authenticateRequest = vi.fn().mockResolvedValueOnce(undefined);
    const authenticateApiKeyWithScope = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, authentication: apiKeyAuthentication });

    await expect(
      authenticateRequestWithScopedApiKey(new Request("https://example.com"), options, {
        authenticateRequest,
        authenticateApiKeyWithScope,
      })
    ).resolves.toEqual({
      ok: true,
      authentication: { type: "apiKey", result: apiKeyAuthentication },
    });
    expect(authenticateApiKeyWithScope).toHaveBeenCalledWith(expect.any(Request), options.apiKey);
  });
});
