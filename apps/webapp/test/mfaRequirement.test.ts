import { afterEach, describe, expect, it } from "vitest";

// env.server.ts parses process.env at import time, so flip the flag before the
// module under test (and the env module it depends on) loads. The off-state
// cases below turn it back off per-test rather than needing a second file.
process.env.MFA_REQUIRED = "1";

const { env } = await import("~/env.server");
const { isMfaExemptPath, mfaRequirementRedirect } =
  await import("~/services/mfa/mfaRequirement.server");

const requestFor = (path: string) => new Request(`https://app.example.com${path}`);

// The Location header is emitted as a relative path ("/mfa/setup?..."), so
// resolving it needs the same origin the request was made against.
const locationOf = (response: Response) =>
  new URL(response.headers.get("location")!, "https://app.example.com");

const enrolled = { mfaEnabledAt: new Date() };
const notEnrolled = { mfaEnabledAt: null };

afterEach(() => {
  // Restored rather than left on, so a later test in this file that expects the
  // flag off starts from the right state.
  env.MFA_REQUIRED = true;
});

describe("isMfaExemptPath", () => {
  it("exempts the setup page, the whole auth flow and logout", () => {
    for (const path of [
      "/mfa/setup",
      "/login",
      "/login/mfa",
      "/login/magic",
      "/login/sso",
      "/logout",
      "/magic",
      "/auth/github/callback",
      "/auth/google/callback",
      "/auth/sso/callback",
    ]) {
      expect(isMfaExemptPath(path), `${path} should be exempt`).toBe(true);
    }
  });

  it("exempts the MFA setup fetcher endpoint", () => {
    expect(isMfaExemptPath("/resources/account/mfa/setup")).toBe(true);
  });

  it("does not exempt other resource endpoints", () => {
    expect(isMfaExemptPath("/resources/account/session-duration")).toBe(false);
    expect(isMfaExemptPath("/resources/some/other/endpoint")).toBe(false);
  });

  it("does not exempt dashboard routes", () => {
    for (const path of [
      "/",
      "/account/security",
      "/account/tokens",
      "/invites",
      "/admin",
      "/orgs/acme/envs/production/runs",
      "/confirm-basic-details",
    ]) {
      expect(isMfaExemptPath(path), `${path} should not be exempt`).toBe(false);
    }
  });

  it("does not treat a prefix of an exempt path as exempt", () => {
    // "/logins" must not match the "/login" exact entry, and a bare "/auth"
    // (no trailing segment) is not a real route but is also not exempt here.
    expect(isMfaExemptPath("/logins")).toBe(false);
  });
});

describe("mfaRequirementRedirect", () => {
  it("redirects a signed-in user without MFA to the setup page", () => {
    const response = mfaRequirementRedirect(requestFor("/orgs/acme"), notEnrolled);

    expect(response).not.toBeNull();
    expect(response?.status).toBe(302);

    const location = locationOf(response!);
    expect(location.pathname).toBe("/mfa/setup");
    // The blocked destination is carried across so they land where they meant to.
    expect(location.searchParams.get("redirectTo")).toBe("/orgs/acme");
  });

  it("preserves the query string of the blocked request", () => {
    const response = mfaRequirementRedirect(
      requestFor("/orgs/acme/envs/dev/runs?run=abc&tab=logs"),
      notEnrolled
    );

    const location = locationOf(response!);
    expect(location.searchParams.get("redirectTo")).toBe(
      "/orgs/acme/envs/dev/runs?run=abc&tab=logs"
    );
  });

  it("sanitizes a redirect target that is not a navigable path", () => {
    // A resource endpoint would render blank as a destination, so it falls back
    // to the root path instead of being propagated.
    const response = mfaRequirementRedirect(requestFor("/resources/foo"), notEnrolled);

    const location = locationOf(response!);
    expect(location.searchParams.get("redirectTo")).toBe("/");
  });

  it("allows a user who has enrolled MFA", () => {
    expect(mfaRequirementRedirect(requestFor("/orgs/acme"), enrolled)).toBeNull();
  });

  it("does nothing when the flag is off", () => {
    env.MFA_REQUIRED = false;

    expect(mfaRequirementRedirect(requestFor("/orgs/acme"), notEnrolled)).toBeNull();
  });

  it("does nothing for a logged-out request", () => {
    expect(mfaRequirementRedirect(requestFor("/orgs/acme"), null)).toBeNull();
  });

  it("allows the exempt paths through so the user can enroll or log out", () => {
    for (const path of ["/mfa/setup", "/login", "/login/mfa", "/logout", "/magic"]) {
      expect(mfaRequirementRedirect(requestFor(path), notEnrolled), `${path}`).toBeNull();
    }
  });
});

describe("throwIfMfaRequired", () => {
  it("throws the redirect when the user is missing MFA", async () => {
    const { throwIfMfaRequired } = await import("~/services/mfa/mfaRequirement.server");

    expect(() => throwIfMfaRequired(requestFor("/orgs/acme"), notEnrolled)).toThrow();
  });

  it("does not throw when the user has enrolled", async () => {
    const { throwIfMfaRequired } = await import("~/services/mfa/mfaRequirement.server");

    expect(() => throwIfMfaRequired(requestFor("/orgs/acme"), enrolled)).not.toThrow();
  });
});
