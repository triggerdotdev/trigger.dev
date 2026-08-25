import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { env } from "~/env.server";
import { redirectWithImpersonation } from "~/models/admin.server";
import {
  commitImpersonationSession,
  getImpersonationId,
  getImpersonationState,
  setImpersonationId,
} from "~/services/impersonation.server";

vi.setConfig({ testTimeout: 30_000 });

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

// IMPERSONATION_ENABLED=false must make impersonation fully inert: starting
// one 404s, and an existing cookie resolves to nothing however it was
// obtained. Stopping is deliberately never gated, so no test pins it here.
describe("impersonation disabled", () => {
  containerTest("starting impersonation 404s and cookies are inert", async ({ prisma }) => {
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
      const state = await getImpersonationState(requestWithCookie(), admin.id);
      expect(state.isImpersonating).toBe(false);
    } finally {
      // @ts-expect-error restore the parsed env
      env.IMPERSONATION_ENABLED = original;
    }

    // Flag back on: the same cookie resolves again.
    expect(await getImpersonationId(requestWithCookie())).toBe(target.id);
  });
});
