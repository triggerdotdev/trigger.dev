import { describe, expect, it } from "vitest";
import {
  isSupportAccessExpired,
  resolveImpersonationState,
  supportAccessDecision,
} from "./impersonationState";

const IMPERSONATED = "user_1";
const ADMIN = "admin_1";

describe("resolveImpersonationState", () => {
  it("reports impersonation when the cookie's id is the resolved user", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: undefined,
        resolvedUserId: IMPERSONATED,
      })
    ).toEqual({ isImpersonating: true, isViewingAsUser: false });
  });

  it("carries the view-as-user flag inside an impersonation session", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: IMPERSONATED,
      })
    ).toEqual({ isImpersonating: true, isViewingAsUser: true });
  });

  // The case the strict comparison exists for: the session falls back to the
  // real admin's id when their admin role is revoked mid-session, while the
  // cookie still names the impersonation target. Both flags must read false so
  // the server-side values and the value published to the client agree.
  it("reports neither flag when the impersonated id is not the resolved user", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: ADMIN,
      })
    ).toEqual({ isImpersonating: false, isViewingAsUser: false });
  });

  it("reports neither flag when there is no impersonated id", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: undefined,
        viewingAsUser: true,
        resolvedUserId: IMPERSONATED,
      })
    ).toEqual({ isImpersonating: false, isViewingAsUser: false });
  });

  it("reports neither flag when there is no resolved user", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: undefined,
      })
    ).toEqual({ isImpersonating: false, isViewingAsUser: false });
  });

  it("only treats a literal true as the view-as-user flag", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: "true",
        resolvedUserId: IMPERSONATED,
      }).isViewingAsUser
    ).toBe(false);
  });
});

describe("support access expiry", () => {
  const NOW = 1_800_000_000_000;

  it("keeps an unscoped session impersonating", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: undefined,
        resolvedUserId: IMPERSONATED,
        supportAccessExpiresAt: undefined,
        now: NOW,
      }).isImpersonating
    ).toBe(true);
  });

  it("keeps a scoped session impersonating until its expiry", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: IMPERSONATED,
        supportAccessExpiresAt: NOW + 1,
        now: NOW,
      })
    ).toEqual({ isImpersonating: true, isViewingAsUser: true });
  });

  it("stops impersonating once the scoped session expires", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: true,
        resolvedUserId: IMPERSONATED,
        supportAccessExpiresAt: NOW,
        now: NOW,
      })
    ).toEqual({ isImpersonating: false, isViewingAsUser: false });
  });

  it("treats a malformed expiry as expired", () => {
    expect(isSupportAccessExpired("tomorrow", NOW)).toBe(true);
    expect(isSupportAccessExpired(Number.NaN, NOW)).toBe(true);
    expect(isSupportAccessExpired(null, NOW)).toBe(true);
  });
});

describe("support access decision", () => {
  const ORIGIN = "https://app.example";
  const decide = (
    path: string,
    referer: string | null = null,
    orgSlugs: unknown = ["a"],
    method = "GET"
  ) => supportAccessDecision({ orgSlugs, url: new URL(`${ORIGIN}${path}`), referer, method }).type;

  it("allows the session's org pages and org resource routes", () => {
    expect(decide("/orgs/a/projects/p")).toBe("allow");
    expect(decide("/resources/orgs/a/projects/p/env/dev")).toBe("allow");
  });

  it("denies other orgs, even when called from the session's org", () => {
    expect(decide("/orgs/b/projects/p")).toBe("deny");
    expect(decide("/orgs/ab")).toBe("deny");
    expect(decide("/resources/orgs/b/x", `${ORIGIN}/orgs/a/projects`)).toBe("deny");
  });

  it("allows ID-keyed routes only when called from a page in the session's org", () => {
    expect(decide("/resources/taskruns/run_1/cancel", `${ORIGIN}/orgs/a/runs`)).toBe("allow");
    expect(decide("/resources/taskruns/run_1/cancel")).toBe("deny");
    expect(decide("/resources/taskruns/run_1/cancel", `${ORIGIN}/orgs/b/runs`)).toBe("deny");
    expect(decide("/resources/taskruns/run_1/cancel", "https://evil.example/orgs/a")).toBe("deny");
    expect(decide("/resources/b/subscription/portal")).toBe("deny");
    expect(decide("/resources/a/subscription/portal", `${ORIGIN}/orgs/a/settings/billing`)).toBe(
      "allow"
    );
  });

  it("lets the customer's account pages be viewed but not changed", () => {
    const fromOrg = `${ORIGIN}/orgs/a/projects`;
    expect(decide("/account/tokens")).toBe("allow");
    expect(decide("/account/security")).toBe("allow");
    expect(decide("/account/tokens", fromOrg, ["a"], "POST")).toBe("deny");
    expect(decide("/account", null, ["a"], "POST")).toBe("deny");
  });

  it("never allows account-level changes, whatever the caller", () => {
    const fromOrg = `${ORIGIN}/orgs/a/projects`;
    expect(decide("/account/authorization-code/abc", fromOrg)).toBe("deny");
    expect(decide("/resources/account/mfa/setup", fromOrg)).toBe("deny");
    expect(decide("/resources/account/session-duration", fromOrg, ["a"], "POST")).toBe("deny");
    expect(decide("/orgs/new", fromOrg)).toBe("deny");
    expect(decide("/projects/new", fromOrg)).toBe("deny");
  });

  it("follows pasted short links, which only redirect into /orgs/<slug>", () => {
    expect(decide("/runs/run_123")).toBe("allow");
    expect(decide("/deployments/dep_1")).toBe("allow");
    expect(decide("/_/org/project/env")).toBe("allow");
    expect(decide("/projects/proj_1")).toBe("allow");
    expect(decide("/projects/v3/proj_1")).toBe("allow");
    expect(decide("/projects/v3/proj_1/runs")).toBe("allow");
    expect(decide("/projects/v3/proj_1/runs/run_1")).toBe("allow");
    expect(decide("/projects/v3/proj_1/metrics")).toBe("deny");
  });

  it("sends / to the session's org instead of the customer's last-used org", () => {
    expect(
      supportAccessDecision({
        orgSlugs: ["a"],
        url: new URL(`${ORIGIN}/`),
        referer: null,
        method: "GET",
      })
    ).toEqual({
      type: "deny",
      reason: "outside_session",
      homeSlug: "a",
    });
  });

  it("marks never-allowed paths so the session's org can't redirect into a loop", () => {
    const reason = (path: string) => {
      const decision = supportAccessDecision({
        orgSlugs: ["a"],
        url: new URL(`${ORIGIN}${path}`),
        referer: null,
        method: "GET",
      });
      return decision.type === "deny" ? decision.reason : undefined;
    };
    expect(reason("/confirm-basic-details")).toBe("never_allowed");
    expect(reason("/orgs/new")).toBe("never_allowed");
    expect(reason("/orgs/b")).toBe("outside_session");
  });

  it("matches paths the way the router does, ignoring case and percent-encoding", () => {
    const fromOrg = `${ORIGIN}/orgs/a/projects`;
    expect(decide("/ORGS/b/projects", fromOrg)).toBe("deny");
    expect(decide("/%6Frgs/b", fromOrg)).toBe("deny");
    expect(decide("/Resources/orgs/b/x", fromOrg)).toBe("deny");
    expect(decide("/ACCOUNT/tokens", fromOrg, ["a"], "POST")).toBe("deny");
    expect(decide("/%61ccount/tokens", fromOrg, ["a"], "POST")).toBe("deny");
    expect(decide("/Resources/Account/mfa/setup", fromOrg)).toBe("deny");
    expect(decide("/INVITE-accept", fromOrg)).toBe("deny");
    expect(decide("/Orgs/A/projects")).toBe("allow");
    expect(decide("/resources/taskruns/run_1/cancel", `${ORIGIN}/ORGS/a/runs`)).toBe("allow");
    expect(decide("/resources/taskruns/run_1/cancel", `${ORIGIN}/ORGS/b/runs`)).toBe("deny");
  });

  it("denies paths that don't decode", () => {
    expect(decide("/orgs/a/%E0%A4%A", `${ORIGIN}/orgs/a/projects`)).toBe("deny");
  });

  it("keeps an encoded slash inside one segment, like the router", () => {
    expect(decide("/orgs%2Fa/projects", `${ORIGIN}/orgs/b/runs`)).toBe("deny");
  });

  it("keeps the exit and admin paths reachable", () => {
    expect(decide("/@")).toBe("allow");
    expect(decide("/admin")).toBe("allow");
    expect(decide("/logout")).toBe("allow");
    expect(decide("/resources/impersonation")).toBe("allow");
    expect(decide("/resources/impersonation/view-as")).toBe("allow");
    expect(decide("/resources/impersonationx")).toBe("deny");
  });

  it("denies everything but the exit paths when the cookie has no org list", () => {
    const noList = (path: string) =>
      supportAccessDecision({
        orgSlugs: undefined,
        url: new URL(`${ORIGIN}${path}`),
        referer: null,
      }).type;
    expect(noList("/orgs/a")).toBe("deny");
    expect(noList("/@")).toBe("allow");
    expect(decide("/orgs/a", null, "a")).toBe("deny");
    expect(decide("/orgs/a", null, [])).toBe("deny");
  });

  it("stops impersonating outside the session", () => {
    expect(
      resolveImpersonationState({
        impersonatedUserId: IMPERSONATED,
        viewingAsUser: undefined,
        resolvedUserId: IMPERSONATED,
        supportAccessRequest: {
          orgSlugs: ["a"],
          url: new URL(`${ORIGIN}/orgs/b/projects`),
          referer: null,
          method: "GET",
        },
      }).isImpersonating
    ).toBe(false);
  });
});
