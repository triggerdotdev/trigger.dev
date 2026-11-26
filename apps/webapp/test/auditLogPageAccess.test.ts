// Which org's audit log page a user may open, against real Postgres: a member, of an org with audit
// log access, unless they're an admin or impersonating. Anything else is no org, which the page and
// its filter options route answer with 404 before checking the role (dashboardBuilder.server).
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";
import { auditLogPageOrganizationId } from "~/services/auditLogs/auditLogsAccess.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";

vi.setConfig({ testTimeout: 60_000 });

const suffix = () => Math.random().toString(36).slice(2, 10);

async function createOrg(prisma: PrismaClient, withAccess: boolean) {
  const slug = `org-${suffix()}`;
  return prisma.organization.create({
    data: {
      title: slug,
      slug,
      featureFlags: withAccess ? { [FEATURE_FLAG.hasAuditLogsAccess]: true } : {},
    },
  });
}

async function createMember(prisma: PrismaClient, organizationId: string) {
  const user = await prisma.user.create({
    data: { email: `${suffix()}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  await prisma.orgMember.create({ data: { organizationId, userId: user.id } });
  return user;
}

const member = (id: string) => ({ id, admin: false, isImpersonating: false });

describe("audit log page access", () => {
  // Catches: the page shown to an org without audit logs, which would also let a role without
  // the permission learn it exists from a 403.
  postgresTest("opens for a member of an org with audit log access only", async ({ prisma }) => {
    const withAccess = await createOrg(prisma, true);
    const without = await createOrg(prisma, false);
    const user = await createMember(prisma, withAccess.id);
    await prisma.orgMember.create({ data: { organizationId: without.id, userId: user.id } });

    await expect(
      auditLogPageOrganizationId(prisma, withAccess.slug, member(user.id))
    ).resolves.toBe(withAccess.id);
    await expect(
      auditLogPageOrganizationId(prisma, without.slug, member(user.id))
    ).resolves.toBeUndefined();
  });

  // Catches: another org's log reachable by slug, or a deleted org's.
  postgresTest(
    "never opens an org the user isn't a member of, or a deleted one",
    async ({ prisma }) => {
      const org = await createOrg(prisma, true);
      const outsider = await createMember(prisma, (await createOrg(prisma, true)).id);
      const insider = await createMember(prisma, org.id);

      await expect(
        auditLogPageOrganizationId(prisma, org.slug, member(outsider.id))
      ).resolves.toBeUndefined();
      // Not even for an admin: staff reach another org's log by impersonating one of its members.
      await expect(
        auditLogPageOrganizationId(prisma, org.slug, { ...member(outsider.id), admin: true })
      ).resolves.toBeUndefined();

      await prisma.organization.update({ where: { id: org.id }, data: { deletedAt: new Date() } });
      await expect(
        auditLogPageOrganizationId(prisma, org.slug, member(insider.id))
      ).resolves.toBeUndefined();
    }
  );

  // Catches: staff unable to open an org's log while supporting it before the org has access.
  postgresTest(
    "opens for admins and impersonators without audit log access",
    async ({ prisma }) => {
      const org = await createOrg(prisma, false);
      const user = await createMember(prisma, org.id);

      await expect(
        auditLogPageOrganizationId(prisma, org.slug, { ...member(user.id), admin: true })
      ).resolves.toBe(org.id);
      await expect(
        auditLogPageOrganizationId(prisma, org.slug, { ...member(user.id), isImpersonating: true })
      ).resolves.toBe(org.id);
    }
  );
});
