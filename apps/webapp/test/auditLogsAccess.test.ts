// Who can see the audit log, against real Postgres: the org's `hasAuditLogsAccess` override, then
// the global FeatureFlag row, then off. Admins and impersonators always can.
import type { PrismaClient } from "@trigger.dev/database";
import { postgresTest } from "@internal/testcontainers";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_LOG_PERMISSION,
  hasAuditLogsAccess,
  organizationHasAuditLogsAccess,
  permissionsShownToOrg,
} from "~/services/auditLogs/auditLogsAccess.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeSetFlag } from "~/v3/featureFlags.server";

vi.setConfig({ testTimeout: 60_000 });

const KEY = FEATURE_FLAG.hasAuditLogsAccess;
const MEMBER = { admin: false, isImpersonating: false };

async function createOrg(prisma: PrismaClient, featureFlags?: Record<string, unknown>) {
  const slug = `org-${Math.random().toString(36).slice(2, 10)}`;
  return prisma.organization.create({ data: { title: slug, slug, featureFlags } });
}

describe("audit log access flag", () => {
  // Catches: the audit log shown to every org before the read side is ready.
  postgresTest("is off without an override or a global row", async ({ prisma }) => {
    const org = await createOrg(prisma);

    await expect(organizationHasAuditLogsAccess(org.id, prisma)).resolves.toBe(false);
    await expect(hasAuditLogsAccess(MEMBER, org.id, prisma)).resolves.toBe(false);
  });

  // Catches: the per-org rollout not working.
  postgresTest("an org override turns it on for that org only", async ({ prisma }) => {
    const flagged = await createOrg(prisma, { [KEY]: true });
    const other = await createOrg(prisma);

    await expect(organizationHasAuditLogsAccess(flagged.id, prisma)).resolves.toBe(true);
    await expect(organizationHasAuditLogsAccess(other.id, prisma)).resolves.toBe(false);
  });

  // Catches: turning it on for everyone not working, or an org's opt-out being ignored.
  postgresTest("follows a global true unless the org overrides it", async ({ prisma }) => {
    await makeSetFlag(prisma)({ key: KEY, value: true });
    const following = await createOrg(prisma, { someOtherFlag: true });
    const optedOut = await createOrg(prisma, { [KEY]: false });

    await expect(organizationHasAuditLogsAccess(following.id, prisma)).resolves.toBe(true);
    await expect(organizationHasAuditLogsAccess(optedOut.id, prisma)).resolves.toBe(false);
  });

  // Catches: coercion reading the string "false" as on.
  postgresTest("treats a non-boolean override as unset", async ({ prisma }) => {
    const org = await createOrg(prisma, { [KEY]: "false" });

    await expect(organizationHasAuditLogsAccess(org.id, prisma)).resolves.toBe(false);
  });

  // Catches: staff unable to see an org's audit log while supporting it, or the org-level check
  // (the API's) letting admins through.
  postgresTest(
    "admins and impersonators see it; the org check has no bypass",
    async ({ prisma }) => {
      const org = await createOrg(prisma);

      await expect(
        hasAuditLogsAccess({ admin: true, isImpersonating: false }, org.id, prisma)
      ).resolves.toBe(true);
      await expect(
        hasAuditLogsAccess({ admin: false, isImpersonating: true }, org.id, prisma)
      ).resolves.toBe(true);
      await expect(organizationHasAuditLogsAccess(org.id, prisma)).resolves.toBe(false);
    }
  );
});

describe("permissionsShownToOrg", () => {
  const permissions = [
    { name: "read:members", description: "See members" },
    { name: AUDIT_LOG_PERMISSION, description: "View the organisation audit log" },
    { name: "manage:supportAccess", description: "Support access" },
  ];

  // Catches: the Roles page offering a permission that does nothing for this org yet.
  it("leaves out manage:audit-logs without audit log access", () => {
    expect(permissionsShownToOrg(permissions, false).map((p) => p.name)).toEqual([
      "read:members",
      "manage:supportAccess",
    ]);
  });

  // Catches: the permission hidden from an org that has the audit log.
  it("lists everything with audit log access", () => {
    expect(permissionsShownToOrg(permissions, true)).toEqual(permissions);
  });
});
