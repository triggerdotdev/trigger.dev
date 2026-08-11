import { describe, expect, it, vi } from "vitest";

vi.mock("../utilities/configFiles.js", () => ({
  readAuthConfigProfile: vi.fn(() => undefined),
}));

import { authenticateForDeploy, userIdForDeploy } from "./auth.js";
import { readAuthConfigProfile } from "../utilities/configFiles.js";

describe("authenticateForDeploy", () => {
  it("uses an API key from TRIGGER_ACCESS_TOKEN without logging in", async () => {
    let loginCalled = false;

    const result = await authenticateForDeploy({
      accessToken: "tr_prod_sk_deploy",
      apiUrl: "https://example.trigger.dev",
      profile: "default",
      silent: true,
      login: async () => {
        loginCalled = true;
        return { ok: false, error: "should not be called" };
      },
    });

    expect(loginCalled).toBe(false);
    expect(result).toEqual({
      ok: true,
      profile: "default",
      dashboardUrl: "https://example.trigger.dev",
      auth: {
        apiUrl: "https://example.trigger.dev",
        accessToken: "tr_prod_sk_deploy",
        tokenType: "apiKey",
      },
    });
  });

  it("derives hosted dashboard links without user metadata", async () => {
    const result = await authenticateForDeploy({
      accessToken: "tr_preview_sk_deploy",
      apiUrl: "https://api.example.trigger.dev",
      profile: "default",
      silent: true,
      login: async () => ({ ok: false, error: "should not be called" }),
    });

    expect(result).toMatchObject({
      dashboardUrl: "https://example.trigger.dev",
      auth: { apiUrl: "https://api.example.trigger.dev" },
    });
  });

  it("uses the normal cloud URLs when no API URL is set", async () => {
    const result = await authenticateForDeploy({
      accessToken: "tr_prod_sk_deploy",
      profile: "default",
      silent: true,
      login: async () => ({ ok: false, error: "should not be called" }),
    });

    expect(result).toMatchObject({
      dashboardUrl: "https://cloud.trigger.dev",
      auth: { apiUrl: "https://api.trigger.dev" },
    });
  });

  it("falls back to the saved profile's API URL for self-hosted instances", async () => {
    vi.mocked(readAuthConfigProfile).mockReturnValueOnce({
      apiUrl: "https://trigger.internal.example.com",
    });

    const result = await authenticateForDeploy({
      accessToken: "tr_prod_sk_deploy",
      profile: "selfhosted",
      silent: true,
      login: async () => ({ ok: false, error: "should not be called" }),
    });

    expect(result).toMatchObject({
      dashboardUrl: "https://trigger.internal.example.com",
      auth: { apiUrl: "https://trigger.internal.example.com" },
    });
  });

  it("prefers an explicit API URL over the saved profile", async () => {
    vi.mocked(readAuthConfigProfile).mockReturnValueOnce({
      apiUrl: "https://trigger.internal.example.com",
    });

    const result = await authenticateForDeploy({
      accessToken: "tr_prod_sk_deploy",
      apiUrl: "https://api.trigger.dev",
      profile: "selfhosted",
      silent: true,
      login: async () => ({ ok: false, error: "should not be called" }),
    });

    expect(result).toMatchObject({
      auth: { apiUrl: "https://api.trigger.dev" },
    });
  });

  it("passes a PAT through to the login path", async () => {
    let loginOptions: unknown;
    const result = await authenticateForDeploy({
      accessToken: "tr_pat_abc123",
      apiUrl: "https://example.trigger.dev",
      profile: "ci",
      silent: false,
      login: async (options) => {
        loginOptions = options;
        return { ok: false, error: "login result" };
      },
    });

    expect(loginOptions).toEqual({
      embedded: true,
      defaultApiUrl: "https://example.trigger.dev",
      profile: "ci",
      silent: false,
    });
    expect(result).toEqual({ ok: false, error: "login result" });
  });

  it("passes an OAT through to the login path", async () => {
    let loginOptions: unknown;
    const result = await authenticateForDeploy({
      accessToken: "tr_oat_abc123",
      apiUrl: "https://example.trigger.dev",
      profile: "ci",
      silent: false,
      login: async (options) => {
        loginOptions = options;
        return { ok: false, error: "login result" };
      },
    });

    expect(loginOptions).toEqual({
      embedded: true,
      defaultApiUrl: "https://example.trigger.dev",
      profile: "ci",
      silent: false,
    });
    expect(result).toEqual({ ok: false, error: "login result" });
  });

  it("keeps login authentication when no access token is set", async () => {
    let loginOptions: unknown;
    const result = await authenticateForDeploy({
      apiUrl: "https://example.trigger.dev",
      profile: "ci",
      silent: false,
      login: async (options) => {
        loginOptions = options;
        return { ok: false, error: "login result" };
      },
    });

    expect(loginOptions).toEqual({
      embedded: true,
      defaultApiUrl: "https://example.trigger.dev",
      profile: "ci",
      silent: false,
    });
    expect(result).toEqual({ ok: false, error: "login result" });
  });

  it("throws a descriptive error for an invalid API URL", async () => {
    await expect(
      authenticateForDeploy({
        accessToken: "tr_prod_sk_deploy",
        apiUrl: "not-a-url",
        profile: "default",
        silent: true,
        login: async () => ({ ok: false, error: "should not be called" }),
      })
    ).rejects.toThrow(
      'Invalid API URL "not-a-url". Check your TRIGGER_API_URL environment variable or --api-url flag.'
    );
  });
});

describe("userIdForDeploy", () => {
  it("omits user attribution for API-key deployments", () => {
    expect(
      userIdForDeploy({
        ok: true,
        profile: "default",
        dashboardUrl: "https://cloud.trigger.dev",
        auth: {
          apiUrl: "https://api.trigger.dev",
          accessToken: "tr_prod_sk_deploy",
          tokenType: "apiKey",
        },
      })
    ).toBeUndefined();
  });
});
