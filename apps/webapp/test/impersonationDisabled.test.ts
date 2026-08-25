import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { env } from "~/env.server";
import { clearImpersonation, redirectWithImpersonation } from "~/models/admin.server";
import {
  commitImpersonationSession,
  getImpersonationId,
  getImpersonationState,
  getRawImpersonationId,
  setImpersonationId,
} from "~/services/impersonation.server";

vi.setConfig({ testTimeout: 30_000 });

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

// IMPERSONATION_ENABLED=false must make impersonation fully inert: starting
// one 404s, and an existing cookie resolves to nothing however it was
// obtained. Stopping stays possible with the flag off — that's how lingering
// sessions get terminated — and must still clear the cookie.
describe("impersonation disabled", () => {
  postgresTest("the flag defaults to enabled", async () => {
    // Flipping this default would kill impersonation on every existing
    // deployment that never heard of the flag.
    expect(env.IMPERSONATION_ENABLED).toBe(true);
  });

  postgresTest("starting impersonation 404s and cookies are inert", async ({ prisma }) => {
    const admin = await prisma.user.create({
      data: {
        email: `admin-${suffix()}@test.local`,
        authenticationMethod: "MAGIC_LINK",
        admin: true,
      },
    });
    const target = await prisma.user.create({
      data: {
        email: `target-${suffix()}@test.local`,
        authenticationMethod: "MAGIC_LINK",
        confirmedBasicDetails: true,
      },
    });

    // A cookie minted while the flag was on, e.g. carried over or replayed.
    const session = await setImpersonationId(target.id, new Request("http://localhost:3030/admin"));
    const cookie = await commitImpersonationSession(session);
    const requestWithCookie = () =>
      new Request("http://localhost:3030/", { headers: { Cookie: cookie } });

    expect(await getImpersonationId(requestWithCookie())).toBe(target.id);
    // resolvedUserId must match the impersonated id for the state to count as
    // impersonating — that's what getUserId resolves to while the cookie works.
    const enabledState = await getImpersonationState(requestWithCookie(), target.id);
    expect(enabledState.isImpersonating).toBe(true);

    const original = env.IMPERSONATION_ENABLED;
    // @ts-expect-error deliberately flipping the parsed env for the test
    env.IMPERSONATION_ENABLED = false;
    try {
      await expect(
        redirectWithImpersonation(
          new Request("http://localhost:3030/admin/impersonate", { method: "POST" }),
          target.id,
          "/",
          { id: admin.id, admin: true },
          prisma
        )
      ).rejects.toMatchObject({ status: 404 });

      // No audit log: the gate fires before anything is recorded.
      expect(await prisma.impersonationAuditLog.count()).toBe(0);

      expect(await getImpersonationId(requestWithCookie())).toBeUndefined();
      const disabledState = await getImpersonationState(requestWithCookie(), target.id);
      expect(disabledState.isImpersonating).toBe(false);

      // The ungated reader still sees the cookie — it's what stop/scrub paths
      // use to terminate a session the gated reader no longer resolves.
      expect(await getRawImpersonationId(requestWithCookie())).toBe(target.id);

      // Stopping works with the flag off and clears the cookie.
      const response = await clearImpersonation(requestWithCookie(), "/");
      const setCookie = response.headers.get("set-cookie");
      expect(setCookie).toContain("__impersonate=");
      const clearedRequest = new Request("http://localhost:3030/", {
        headers: { Cookie: setCookie!.split(";")[0] },
      });
      expect(await getRawImpersonationId(clearedRequest)).toBeUndefined();
    } finally {
      // @ts-expect-error restore the parsed env
      env.IMPERSONATION_ENABLED = original;
    }
  });
});
