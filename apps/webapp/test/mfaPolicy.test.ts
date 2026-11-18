import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as MfaRequirement from "~/services/mfa/mfaRequirement.server";

const h = vi.hoisted(() => ({
  setupRequired: false,
  windowMinutes: undefined as number | undefined,
  verifiedAt: undefined as number | undefined,
  userHasMfa: true,
  userIsAdmin: false,
  impersonating: false,
}));

vi.mock("~/services/mfa/mfaRequirement.server", async (importOriginal) => {
  const actual = await importOriginal<typeof MfaRequirement>();
  return {
    isMfaVerificationFresh: actual.isMfaVerificationFresh,
    isMfaSetupRequired: vi.fn(async () => h.setupRequired),
    stepUpWindowMinutes: vi.fn(async () => h.windowMinutes),
  };
});
vi.mock("~/db.server", () => ({
  prisma: {
    user: {
      findFirst: async () => ({
        mfaEnabledAt: h.userHasMfa ? new Date() : null,
        admin: h.userIsAdmin,
      }),
    },
  },
}));
vi.mock("~/models/message.server", () => ({
  redirectWithErrorMessage: async (path: string) =>
    new Response(null, { status: 302, headers: { Location: path } }),
}));
vi.mock("~/services/impersonation.server", () => ({
  getImpersonationId: async () => (h.impersonating ? "user_target" : undefined),
}));
vi.mock("~/services/sessionStorage.server", () => ({
  getUserSession: async () => ({ get: () => h.verifiedAt }),
}));

import { isMfaSetupRequired } from "~/services/mfa/mfaRequirement.server";
import { enforceMfaSetup, requireRecentMfa } from "~/services/mfa/mfaPolicy.server";

const ORIGIN = "https://cloud.example";

async function thrownLocation(promise: Promise<unknown>) {
  const thrown = await promise.then(
    () => undefined,
    (error) => error
  );
  expect(thrown).toBeInstanceOf(Response);
  return (thrown as Response).headers.get("Location");
}

beforeEach(() => {
  Object.assign(h, {
    setupRequired: false,
    windowMinutes: undefined,
    verifiedAt: undefined,
    userHasMfa: true,
    userIsAdmin: false,
    impersonating: false,
  });
  vi.mocked(isMfaSetupRequired).mockClear();
});

describe("enforceMfaSetup", () => {
  // Catches: a locked-out member redirected away from the pages that set MFA up, in a loop.
  it("lets a locked-out member reach the pages they need to set MFA up", async () => {
    h.setupRequired = true;
    for (const path of [
      "/mfa/setup",
      "/account/security",
      "/account/security/",
      "/resources/account/mfa/setup",
      "/logout",
    ]) {
      await expect(enforceMfaSetup(new Request(`${ORIGIN}${path}`), "u")).resolves.toBeUndefined();
    }
    expect(isMfaSetupRequired).not.toHaveBeenCalled();
  });

  // Catches: a locked-out member reaching any page other than MFA setup.
  it("sends a locked-out member from any other page to MFA setup", async () => {
    h.setupRequired = true;
    const location = await thrownLocation(
      enforceMfaSetup(new Request(`${ORIGIN}/orgs/acme/projects?tab=1&_data=root`), "u")
    );
    expect(location).toBe(
      `/mfa/setup?redirectTo=${encodeURIComponent("/orgs/acme/projects?tab=1")}`
    );
  });

  // Catches: members of orgs without the requirement being sent to MFA setup.
  it("leaves members alone when no org requires MFA from them", async () => {
    await expect(enforceMfaSetup(new Request(`${ORIGIN}/orgs/acme`), "u")).resolves.toBeUndefined();
  });
});

describe("requireRecentMfa", () => {
  const options = { userId: "u", action: "environmentVariables" as const, organizationId: "org" };

  // Catches: an admin impersonating a member being asked for that member's MFA code.
  it("does nothing when the org doesn't ask for a check, or while impersonating", async () => {
    await expect(
      requireRecentMfa(new Request(`${ORIGIN}/env-vars`), options)
    ).resolves.toBeUndefined();
    h.windowMinutes = 5;
    h.impersonating = true;
    await expect(
      requireRecentMfa(new Request(`${ORIGIN}/env-vars`), { ...options, userId: "user_target" })
    ).resolves.toBeUndefined();
  });

  // Catches: a former admin's leftover impersonation cookie skipping their own MFA check.
  it("checks a user whose impersonation cookie names someone else", async () => {
    h.windowMinutes = 5;
    h.impersonating = true;
    expect(await thrownLocation(requireRecentMfa(new Request(`${ORIGIN}/env-vars`), options))).toBe(
      `/mfa/verify?redirectTo=${encodeURIComponent("/env-vars")}`
    );
  });

  // Catches: platform admins being locked behind an org's step-up check.
  it("never asks a platform admin, with or without MFA", async () => {
    h.windowMinutes = 5;
    h.userIsAdmin = true;
    await expect(
      requireRecentMfa(new Request(`${ORIGIN}/env-vars`), options)
    ).resolves.toBeUndefined();
    h.userHasMfa = false;
    await expect(
      requireRecentMfa(new Request(`${ORIGIN}/env-vars`), options)
    ).resolves.toBeUndefined();
  });

  // Catches: an expired check still passing, or a fresh one asked again.
  it("passes inside the window and asks again outside it", async () => {
    h.windowMinutes = 5;
    h.verifiedAt = Date.now() - 60_000;
    await expect(
      requireRecentMfa(new Request(`${ORIGIN}/env-vars`), options)
    ).resolves.toBeUndefined();

    h.verifiedAt = Date.now() - 6 * 60_000;
    const location = await thrownLocation(
      requireRecentMfa(new Request(`${ORIGIN}/env-vars?page=2&_data=routes%2Fx`), options)
    );
    expect(location).toBe(`/mfa/verify?redirectTo=${encodeURIComponent("/env-vars?page=2")}`);
  });

  // Catches: a member without MFA reaching a protected page because there is no code to ask for.
  it("sends a member without MFA to set it up", async () => {
    h.windowMinutes = 5;
    h.userHasMfa = false;
    expect(await thrownLocation(requireRecentMfa(new Request(`${ORIGIN}/env-vars`), options))).toBe(
      "/account/security"
    );
  });

  // Catches: an open redirect through the referer of a form post.
  it("returns a form post to the page it came from, never to another site", async () => {
    h.windowMinutes = 5;
    const post = (referer: string) =>
      new Request(`${ORIGIN}/account/tokens?index`, { method: "POST", headers: { referer } });

    expect(await thrownLocation(requireRecentMfa(post(`${ORIGIN}/account/tokens`), options))).toBe(
      `/mfa/verify?redirectTo=${encodeURIComponent("/account/tokens")}`
    );
    expect(await thrownLocation(requireRecentMfa(post("https://evil.example/x"), options))).toBe(
      `/mfa/verify?redirectTo=${encodeURIComponent("/account/tokens")}`
    );
  });
});
