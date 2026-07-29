import { containerTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { findImpersonationTarget, startImpersonation } from "~/models/admin.server";

vi.setConfig({ testTimeout: 30_000 });

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

// A cross-site `/@/orgs/<slug>/…` navigation renders a consent page instead of
// starting impersonation, so the only work its loader does is the read-only
// target lookup. Lock that the lookup writes nothing, and that the explicit
// POST is what actually starts impersonation.
describe("impersonation consent page", () => {
  containerTest(
    "resolving who a link would impersonate is read-only, and the explicit POST starts impersonation",
    async ({ prisma }) => {
      const admin = await prisma.user.create({
        data: {
          email: `admin-${suffix()}@test.local`,
          authenticationMethod: "MAGIC_LINK",
          admin: true,
        },
      });

      // First member has never confirmed their details, so it must be skipped.
      const unconfirmed = await prisma.user.create({
        data: {
          email: `unconfirmed-${suffix()}@test.local`,
          authenticationMethod: "MAGIC_LINK",
          confirmedBasicDetails: false,
        },
      });
      const confirmed = await prisma.user.create({
        data: {
          email: `confirmed-${suffix()}@test.local`,
          authenticationMethod: "MAGIC_LINK",
          confirmedBasicDetails: true,
        },
      });

      const slug = `acme-${suffix()}`;
      const org = await prisma.organization.create({
        data: {
          title: "Acme Inc",
          slug,
          members: { create: [{ userId: unconfirmed.id }, { userId: confirmed.id }] },
        },
      });

      // What the consent-page loader does: look up the target, nothing else.
      const target = await findImpersonationTarget(org.slug, prisma);
      expect(target).toEqual({
        success: true,
        userId: confirmed.id,
        organizationName: "Acme Inc",
      });

      // Read-only: no impersonation was recorded by rendering the page.
      expect(await prisma.impersonationAuditLog.count()).toBe(0);

      // The consent page's POST: same-origin, and it does start impersonation.
      // The `?span=` is what a `/@/runs/<id>` link redirects with, so it has to
      // survive to the destination or the run opens with no span selected.
      const response = await startImpersonation(
        new Request(
          `http://localhost:3030/@/orgs/${org.slug}/projects/p/runs/run_123?span=span_abc`,
          {
            method: "POST",
            headers: { "sec-fetch-site": "same-origin" },
          }
        ),
        org.slug,
        "projects/p/runs/run_123",
        { id: admin.id, admin: true },
        { read: prisma, write: prisma }
      );

      expect(response.status).toBe(302);
      // The splat path and query string are preserved, `/@` prefix stripped.
      expect(response.headers.get("location")).toBe(
        `/orgs/${org.slug}/projects/p/runs/run_123?span=span_abc`
      );
      expect(response.headers.get("set-cookie")).toContain("__impersonate=");

      const auditLogs = await prisma.impersonationAuditLog.findMany();
      expect(auditLogs).toHaveLength(1);
      expect(auditLogs[0]).toMatchObject({
        action: "START",
        adminId: admin.id,
        targetId: confirmed.id,
      });
    }
  );

  containerTest("an unknown organization slug cannot be impersonated", async ({ prisma }) => {
    expect(await findImpersonationTarget(`missing-${suffix()}`, prisma)).toEqual({
      success: false,
      reason: "org-not-found",
    });
  });

  containerTest(
    "an organization with no confirmed members cannot be impersonated",
    async ({ prisma }) => {
      const user = await prisma.user.create({
        data: {
          email: `unconfirmed-${suffix()}@test.local`,
          authenticationMethod: "MAGIC_LINK",
          confirmedBasicDetails: false,
        },
      });

      const org = await prisma.organization.create({
        data: {
          title: "Nobody Inc",
          slug: `nobody-${suffix()}`,
          members: { create: [{ userId: user.id }] },
        },
      });

      expect(await findImpersonationTarget(org.slug, prisma)).toEqual({
        success: false,
        reason: "no-confirmed-member",
      });
    }
  );

  containerTest("a deleted organization cannot be impersonated", async ({ prisma }) => {
    const user = await prisma.user.create({
      data: {
        email: `confirmed-${suffix()}@test.local`,
        authenticationMethod: "MAGIC_LINK",
        confirmedBasicDetails: true,
      },
    });

    const org = await prisma.organization.create({
      data: {
        title: "Gone Inc",
        slug: `gone-${suffix()}`,
        deletedAt: new Date(),
        members: { create: [{ userId: user.id }] },
      },
    });

    expect(await findImpersonationTarget(org.slug, prisma)).toEqual({
      success: false,
      reason: "org-not-found",
    });
  });
});
