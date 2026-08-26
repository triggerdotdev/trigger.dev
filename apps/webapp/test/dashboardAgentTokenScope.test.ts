import { describe, expect, it } from "vitest";
import { resolveAgentTokenScope } from "~/services/dashboardAgentTokenScope";

describe("resolveAgentTokenScope", () => {
  it("pins an environment-only token and ignores the request", () => {
    const scope = resolveAgentTokenScope(
      { environmentId: "env_token" },
      { environmentId: "env_other" }
    );

    expect(scope).toEqual({ ok: true, environmentId: "env_token" });
  });

  it("honours the request environment for an org-wide token", () => {
    const scope = resolveAgentTokenScope(
      { environmentId: "env_current", organizationId: "org_1" },
      { environmentId: "env_elsewhere" }
    );

    expect(scope).toEqual({ ok: true, environmentId: "env_elsewhere", organizationId: "org_1" });
  });

  it("hands back the org so the caller can reject another org's environment", () => {
    const scope = resolveAgentTokenScope({ organizationId: "org_1" }, { environmentId: "env_x" });

    // The id alone proves nothing; `organizationId` is what the caller checks it against.
    expect(scope).toEqual({ ok: true, environmentId: "env_x", organizationId: "org_1" });
  });

  it("defaults to the token's environment when the request names none", () => {
    const scope = resolveAgentTokenScope(
      { environmentId: "env_current", organizationId: "org_1" },
      {}
    );

    expect(scope).toEqual({ ok: true, environmentId: "env_current", organizationId: "org_1" });
  });

  it("refuses an org-only token with no environment to default to", () => {
    const scope = resolveAgentTokenScope({ organizationId: "org_1" }, {});

    expect(scope.ok).toBe(false);
  });

  it("refuses a token with no scope at all", () => {
    const scope = resolveAgentTokenScope({}, { environmentId: "env_named" });

    expect(scope.ok).toBe(false);
  });
});
