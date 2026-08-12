// Slack support-channel settings page — free-org upsell path. See
// auth-dashboard.e2e.full.test.ts for the seedTestSession harness this
// borrows.
//
// In the e2e environment billing is unconfigured, so every seeded org is
// non-paying — this only exercises the FREE upsell branch of the page. The
// paid branches (INVITED/LINKED/PROVISIONING/connect) aren't covered here;
// see supportSlackChannel.test.ts for the service-level unit/pg coverage of
// those states.

import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { getTestServer } from "./helpers/sharedTestServer";
import { seedTestSession } from "./helpers/seedTestSession";

function randomHex(len = 12): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

// seedTestUser doesn't expose confirmedBasicDetails, and the dashboard shell
// (_app/route.tsx) redirects to /confirm-basic-details until that's true —
// so this seeds the user directly to reach the settings page.
//
// The org/project setup mirrors what OrganizationsPresenter requires to
// resolve a "best project" for the org loader shared by every settings
// page: isActivated: true (managed-cloud orgs start deactivated and get
// redirected through select-plan otherwise) and a version: "V3" project
// (the presenter only lists V3 projects).
async function seedConfirmedOrgWithAdmin(prisma: PrismaClient) {
  const suffix = randomHex(8);
  const user = await prisma.user.create({
    data: {
      email: `e2e-${suffix}@test.local`,
      authenticationMethod: "MAGIC_LINK",
      admin: false,
      confirmedBasicDetails: true,
    },
  });
  const organization = await prisma.organization.create({
    data: {
      title: `Free Org ${suffix}`,
      slug: `free-org-${suffix}`,
      isActivated: true,
      // Per-org opt-in: the feature flag is off globally, so without this the
      // route 404s and the upsell branch below is never reached.
      featureFlags: { supportChannelEnabled: true },
    },
  });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: {
      name: `free-project-${suffix}`,
      slug: `free-proj-${suffix}`,
      externalRef: `proj_${suffix}`,
      organizationId: organization.id,
      version: "V3",
      engine: "V2",
    },
  });
  await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      apiKey: `tr_dev_${randomHex(24)}`,
      pkApiKey: `pk_dev_${randomHex(24)}`,
      shortcode: suffix.slice(0, 4),
      projectId: project.id,
      organizationId: organization.id,
      orgMemberId: (
        await prisma.orgMember.findFirstOrThrow({
          where: { organizationId: organization.id, userId: user.id },
        })
      ).id,
    },
  });

  return { user, organization };
}

describe("Support channel settings page", () => {
  it("GET /orgs/:slug/settings/support shows the upgrade CTA for a free org", async () => {
    const server = getTestServer();
    const { user, organization } = await seedConfirmedOrgWithAdmin(server.prisma);
    const cookie = await seedTestSession({ userId: user.id });

    const res = await server.webapp.fetch(`/orgs/${organization.slug}/settings/support`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Upgrade to unlock");
  });

  it("404s when the feature flag is off", async () => {
    const server = getTestServer();
    const { user, organization } = await seedConfirmedOrgWithAdmin(server.prisma);
    await server.prisma.organization.update({
      where: { id: organization.id },
      data: { featureFlags: { supportChannelEnabled: false } },
    });
    const cookie = await seedTestSession({ userId: user.id });

    const res = await server.webapp.fetch(`/orgs/${organization.slug}/settings/support`, {
      headers: { Cookie: cookie },
    });

    expect(res.status).toBe(404);
  });

  it("POST intent=connect is rejected for a free org", async () => {
    const server = getTestServer();
    const { user, organization } = await seedConfirmedOrgWithAdmin(server.prisma);
    const cookie = await seedTestSession({ userId: user.id });

    const body = new URLSearchParams({ intent: "connect" });
    const res = await server.webapp.fetch(`/orgs/${organization.slug}/settings/support`, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
      redirect: "manual",
    });

    expect(res.status).toBe(403);
  });
});
