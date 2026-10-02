import { containerTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { removeTeamMember } from "~/models/removeTeamMember.server";
import rbacLoader from "@trigger.dev/rbac";
import { generateAdditionalApiKey } from "~/utils/apiKeys";
import { createRuntimeEnvironment, uniqueId } from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function seedOrgWithMembers(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
  const admin = await prisma.user.create({
    data: { email: `admin_${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const member = await prisma.user.create({
    data: { email: `member_${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });

  const organization = await prisma.organization.create({
    data: {
      title: slug,
      slug,
      members: {
        createMany: {
          data: [
            { userId: admin.id, role: "ADMIN" },
            { userId: member.id, role: "MEMBER" },
          ],
        },
      },
    },
    include: { members: true },
  });

  const adminMember = organization.members.find((m) => m.userId === admin.id)!;
  const regularMember = organization.members.find((m) => m.userId === member.id)!;
  return { organization, admin, member, adminMember, regularMember };
}

describe("removeTeamMember", () => {
  containerTest(
    "rotates the removed member's root key and revokes additional development keys",
    async ({ prisma }) => {
      const a = await seedOrgWithMembers(prisma, "rotation");
      const project = await prisma.project.create({
        data: {
          name: "Test project",
          slug: uniqueId("project"),
          externalRef: uniqueId("project-ref"),
          organizationId: a.organization.id,
        },
      });
      const environment = await createRuntimeEnvironment(prisma, {
        projectId: project.id,
        organizationId: a.organization.id,
        orgMemberId: a.regularMember.id,
        type: "DEVELOPMENT",
      });
      const additionalKey = generateAdditionalApiKey("DEVELOPMENT");
      await prisma.apiKey.create({
        data: {
          name: "Development key",
          runtimeEnvironmentId: environment.id,
          keyHash: additionalKey.keyHash,
          lastFour: additionalKey.lastFour,
          scopes: ["admin"],
        },
      });
      const controller = rbacLoader.create(prisma, { forceFallback: true });
      const authenticate = (key: string) =>
        controller.authenticateBearer(
          new Request("https://example.com", {
            headers: { Authorization: `Bearer ${key}` },
          })
        );
      for (const key of [environment.apiKey, additionalKey.apiKey]) {
        await expect(authenticate(key)).resolves.toMatchObject({ ok: true });
      }

      await removeTeamMember(
        { userId: a.admin.id, slug: a.organization.slug, memberId: a.regularMember.id },
        prisma
      );

      for (const key of [environment.apiKey, additionalKey.apiKey]) {
        await expect(authenticate(key)).resolves.toMatchObject({ ok: false, status: 401 });
      }
      await expect(
        prisma.runtimeEnvironment.findFirst({ where: { id: environment.id } })
      ).resolves.toMatchObject({ id: environment.id, orgMemberId: null });
    }
  );

  containerTest(
    "refuses to delete an OrgMember that belongs to a different org",
    async ({ prisma }) => {
      const a = await seedOrgWithMembers(prisma, "orga");
      const b = await seedOrgWithMembers(prisma, "orgb");

      await expect(
        removeTeamMember(
          {
            userId: a.admin.id,
            slug: a.organization.slug,
            memberId: b.regularMember.id,
          },
          prisma
        )
      ).rejects.toThrow();

      const stillThere = await prisma.orgMember.findUnique({
        where: { id: b.regularMember.id },
      });
      expect(stillThere).not.toBeNull();
    }
  );

  containerTest("removes a member that belongs to the actor's org", async ({ prisma }) => {
    const a = await seedOrgWithMembers(prisma, "orga");

    const result = await removeTeamMember(
      {
        userId: a.admin.id,
        slug: a.organization.slug,
        memberId: a.regularMember.id,
      },
      prisma
    );
    expect(result.id).toBe(a.regularMember.id);

    const gone = await prisma.orgMember.findUnique({
      where: { id: a.regularMember.id },
    });
    expect(gone).toBeNull();
  });

  containerTest("allows the actor to leave their own org (self-leave)", async ({ prisma }) => {
    const a = await seedOrgWithMembers(prisma, "orga");

    const result = await removeTeamMember(
      {
        userId: a.member.id,
        slug: a.organization.slug,
        memberId: a.regularMember.id,
      },
      prisma
    );
    expect(result.userId).toBe(a.member.id);

    const gone = await prisma.orgMember.findUnique({
      where: { id: a.regularMember.id },
    });
    expect(gone).toBeNull();
  });

  containerTest(
    "throws the in-org not-found error for an unknown memberId (locks the error message the route renders)",
    async ({ prisma }) => {
      const a = await seedOrgWithMembers(prisma, "orga");

      await expect(
        removeTeamMember(
          {
            userId: a.admin.id,
            slug: a.organization.slug,
            memberId: "doesnotexist",
          },
          prisma
        )
      ).rejects.toThrow("Member not found in this organization");
    }
  );

  containerTest("throws when the actor is not a member of the slug org", async ({ prisma }) => {
    const a = await seedOrgWithMembers(prisma, "orga");
    const b = await seedOrgWithMembers(prisma, "orgb");

    await expect(
      removeTeamMember(
        {
          userId: a.admin.id,
          slug: b.organization.slug,
          memberId: b.regularMember.id,
        },
        prisma
      )
    ).rejects.toThrow("User does not have access to this organization");

    const stillThere = await prisma.orgMember.findUnique({
      where: { id: b.regularMember.id },
    });
    expect(stillThere).not.toBeNull();
  });

  containerTest(
    "uses an exact-message error for cross-tenant attempts (locks contract)",
    async ({ prisma }) => {
      const a = await seedOrgWithMembers(prisma, "orga");
      const b = await seedOrgWithMembers(prisma, "orgb");

      await expect(
        removeTeamMember(
          {
            userId: a.admin.id,
            slug: a.organization.slug,
            memberId: b.regularMember.id,
          },
          prisma
        )
      ).rejects.toThrow("Member not found in this organization");
    }
  );

  containerTest(
    "refuses to remove the sole member (last-member guard, locks the message)",
    async ({ prisma }) => {
      const slug = `orgsolo_${Math.random().toString(36).slice(2, 10)}`;
      const soloUser = await prisma.user.create({
        data: { email: `solo_${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
      });
      const organization = await prisma.organization.create({
        data: {
          title: slug,
          slug,
          members: { create: { userId: soloUser.id, role: "ADMIN" } },
        },
        include: { members: true },
      });
      const soloMember = organization.members[0];

      await expect(
        removeTeamMember(
          { userId: soloUser.id, slug: organization.slug, memberId: soloMember.id },
          prisma
        )
      ).rejects.toThrow("Cannot remove the last member of an organization");

      const stillThere = await prisma.orgMember.findUnique({ where: { id: soloMember.id } });
      expect(stillThere).not.toBeNull();
    }
  );
});
