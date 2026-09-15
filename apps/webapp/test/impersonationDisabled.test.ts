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

// ADMIN_DASHBOARD_ENABLED=false: starting 404s, cookies resolve to nothing,
// stopping still works so lingering sessions can be terminated.
describe("impersonation disabled", () => {
  postgresTest("the flag defaults to enabled", async () => {
    // Flipping the default would kill the admin dashboard on every existing deployment.
    expect(env.ADMIN_DASHBOARD_ENABLED).toBe(true);
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
    // resolvedUserId must be the impersonated id or the state is false even
    // with the flag on, making the disabled assertion below vacuous.
    const enabledState = await getImpersonationState(requestWithCookie(), target.id);
    expect(enabledState.isImpersonating).toBe(true);

    const original = env.ADMIN_DASHBOARD_ENABLED;
    // @ts-expect-error deliberately flipping the parsed env for the test
    env.ADMIN_DASHBOARD_ENABLED = false;
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

      // The ungated reader still sees the cookie (stop/scrub paths need it).
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
      env.ADMIN_DASHBOARD_ENABLED = original;
    }
  });
});
