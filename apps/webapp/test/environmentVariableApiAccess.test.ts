import { describe, expect, it, vi } from "vitest";
import {
  apiKeyForProjectEnvironmentBootstrap,
  authenticateEnvironmentBootstrapRequest,
  authenticateEnvVarApiRequest,
  presentedApiKeyFromAuthentication,
} from "~/services/environmentVariableApiAccess.server";

const authenticateRequest = vi.fn();
const authenticateApiKeyRequest = vi.fn();
const authenticateApiKeyWithScope = vi.fn();
const dependencies = { authenticateRequest, authenticateApiKeyWithScope };

describe("presentedApiKeyFromAuthentication", () => {
  it("returns the API key that authenticated the request", () => {
    expect(
      presentedApiKeyFromAuthentication({
        type: "apiKey",
        result: {
          ok: true,
          apiKey: "tr_prod_sk_presented",
          type: "PRIVATE",
          environment: {},
        },
      })
    ).toBe("tr_prod_sk_presented");
  });

  it("does not exchange user tokens for an API key", () => {
    expect(
      presentedApiKeyFromAuthentication({
        type: "personalAccessToken",
        result: { userId: "user_123" },
      })
    ).toBeUndefined();
  });

  it("echoes only the presented API key during bootstrap", () => {
    expect(
      apiKeyForProjectEnvironmentBootstrap(
        {
          type: "apiKey",
          result: {
            ok: true,
            apiKey: "tr_prod_sk_presented",
            type: "PRIVATE",
            environment: {},
          },
        },
        "tr_prod_root"
      )
    ).toBe("tr_prod_sk_presented");
  });

  it("returns the root key to an authorized user token", () => {
    expect(
      apiKeyForProjectEnvironmentBootstrap(
        {
          type: "personalAccessToken",
          result: { userId: "user_123" },
        },
        "tr_prod_root"
      )
    ).toBe("tr_prod_root");
  });
});

describe("authenticateEnvironmentBootstrapRequest", () => {
  it("authenticates API keys without requiring an API-key scope", async () => {
    authenticateRequest.mockResolvedValueOnce(undefined);
    const authentication = {
      ok: true,
      apiKey: "tr_preview_sk_presented",
      type: "PRIVATE",
      environment: {},
    };
    authenticateApiKeyRequest.mockResolvedValueOnce({ ok: true, authentication });

    await expect(
      authenticateEnvironmentBootstrapRequest(new Request("https://example.com"), {
        authenticateRequest,
        authenticateApiKeyRequest,
      })
    ).resolves.toEqual({
      ok: true,
      authentication: { type: "apiKey", result: authentication },
    });
    expect(authenticateApiKeyRequest).toHaveBeenCalledWith(expect.any(Request), {
      allowPreviewParent: true,
    });
  });
});

describe("authenticateEnvVarApiRequest", () => {
  it("keeps PAT authentication on the legacy path", async () => {
    const authentication = { type: "personalAccessToken", result: { userId: "user_123" } } as never;
    authenticateRequest.mockResolvedValueOnce(authentication);

    await expect(
      authenticateEnvVarApiRequest(new Request("https://example.com"), "read", dependencies)
    ).resolves.toEqual({ ok: true, authentication });
    expect(authenticateApiKeyWithScope).not.toHaveBeenCalled();
  });

  it("uses scoped API-key authentication when no PAT is present", async () => {
    authenticateRequest.mockResolvedValueOnce(undefined);
    const authentication = {
      ok: true,
      apiKey: "tr_prod_sk_presented",
      type: "PRIVATE",
      environment: {},
    };
    authenticateApiKeyWithScope.mockResolvedValueOnce({ ok: true, authentication });

    await expect(
      authenticateEnvVarApiRequest(new Request("https://example.com"), "write", dependencies)
    ).resolves.toEqual({ ok: true, authentication: { type: "apiKey", result: authentication } });
    expect(authenticateApiKeyWithScope).toHaveBeenCalledWith(expect.any(Request), {
      action: "write",
      resource: { type: "envvars" },
    });
  });

  it("preserves scoped API-key failures", async () => {
    authenticateRequest.mockResolvedValueOnce(undefined);
    authenticateApiKeyWithScope.mockResolvedValueOnce({
      ok: false,
      status: 403,
      error: "Unauthorized",
    });

    await expect(
      authenticateEnvVarApiRequest(new Request("https://example.com"), "read", dependencies)
    ).resolves.toEqual({ ok: false, status: 403, error: "Unauthorized" });
  });
});
