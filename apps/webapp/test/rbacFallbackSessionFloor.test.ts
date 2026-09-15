import { postgresTest } from "@internal/testcontainers";
import plugin from "@trigger.dev/rbac";
import { type PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import {
  createTestOrgProjectWithMember,
  createTestUser,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

// The RBAC fallback ability is permissive (`can: () => true` for a non-admin), so
// `ability.can` is not a tenant floor. `authenticateSession` is the gate every
// org-scoped dashboard route relies on; a non-member in an org context must be
// denied here, or a permissive ability lets them act on any org whose slug they
// know. The route-level e2e (auth-dashboard.e2e.full) covers the HTTP path; this
// pins the fallback gate directly since that path can't run without a container.
function fallback(prisma: PrismaClient) {
  // forceFallback skips the closed-source plugin and uses the in-repo fallback.
  return plugin.create({ primary: prisma, replica: prisma }, { forceFallback: true });
}

const request = new Request("https://app.trigger.dev/orgs/x/settings/roles");

describe("RBAC fallback authenticateSession — org membership floor", () => {
  postgresTest("denies a non-member in an org context", async ({ prisma }) => {
    const { organization } = await createTestOrgProjectWithMember(prisma);
    const outsider = await createTestUser(prisma);

    const result = await fallback(prisma).authenticateSession(request, {
      userId: outsider.id,
      organizationId: organization.id,
    });

    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  postgresTest("allows a member in an org context", async ({ prisma }) => {
    const { user, organization } = await createTestOrgProjectWithMember(prisma);

    const result = await fallback(prisma).authenticateSession(request, {
      userId: user.id,
      organizationId: organization.id,
    });

    expect(result.ok).toBe(true);
  });

  postgresTest(
    "stays permissive with no org context, even for a non-member",
    async ({ prisma }) => {
      // Identity-only checks (no organizationId) predate any scope, so the floor
      // does not apply and the permissive baseline is preserved.
      const outsider = await createTestUser(prisma);

      const result = await fallback(prisma).authenticateSession(request, { userId: outsider.id });

      expect(result.ok).toBe(true);
    }
  );

  // A project-only scope is still a tenant claim, so the floor resolves the
  // project's organization rather than letting the context through unchecked.
  postgresTest("denies a non-member scoped only to a project", async ({ prisma }) => {
    const { project } = await createTestOrgProjectWithMember(prisma);
    const outsider = await createTestUser(prisma);

    const result = await fallback(prisma).authenticateSession(request, {
      userId: outsider.id,
      projectId: project.id,
    });

    expect(result).toMatchObject({ ok: false, reason: "unauthorized" });
  });

  postgresTest("allows a member scoped only to a project", async ({ prisma }) => {
    const { user, project } = await createTestOrgProjectWithMember(prisma);

    const result = await fallback(prisma).authenticateSession(request, {
      userId: user.id,
      projectId: project.id,
    });

    expect(result.ok).toBe(true);
  });

  // The membership probe reads the replica first and the primary on a miss, so a
  // member whose row has not replicated yet is not bounced. Modelled by giving
  // the controller a replica that cannot see the row and a primary that can.
  postgresTest("allows a member the replica has not caught up on", async ({ prisma }) => {
    const { user, organization } = await createTestOrgProjectWithMember(prisma);
    const blindReplica = {
      ...prisma,
      orgMember: { findFirst: async () => null },
      user: prisma.user,
      project: prisma.project,
    } as unknown as PrismaClient;

    const controller = plugin.create(
      { primary: prisma, replica: blindReplica },
      { forceFallback: true }
    );
    const result = await controller.authenticateSession(request, {
      userId: user.id,
      organizationId: organization.id,
    });

    expect(result.ok).toBe(true);
  });
});
