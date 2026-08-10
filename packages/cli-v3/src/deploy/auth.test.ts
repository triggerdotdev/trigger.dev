import { describe, expect, it } from "vitest";
import { authenticateForDeploy, userIdForDeploy } from "./auth.js";

describe("authenticateForDeploy", () => {
  it("gives TRIGGER_SECRET_KEY precedence without logging in", async () => {
    let loginCalled = false;

    const result = await authenticateForDeploy({
      secretKey: "tr_prod_sk_deploy",
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
      secretKey: "tr_preview_sk_deploy",
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
      secretKey: "tr_prod_sk_deploy",
      profile: "default",
      silent: true,
      login: async () => ({ ok: false, error: "should not be called" }),
    });

    expect(result).toMatchObject({
      dashboardUrl: "https://cloud.trigger.dev",
      auth: { apiUrl: "https://api.trigger.dev" },
    });
  });

  it("keeps login authentication when no secret key is set", async () => {
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
