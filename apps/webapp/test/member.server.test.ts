import { randomBytes } from "node:crypto";
import { describe, expect, vi } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";

const prismaHolder = vi.hoisted(() => ({
  client: null as PrismaClient | null,
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    setUserRole: async () => ({ ok: true as const }),
  },
}));

vi.mock("~/db.server", () => ({
  get prisma() {
    if (!prismaHolder.client) {
      throw new Error("test prisma not set");
    }
    return prismaHolder.client;
  },
  get $replica() {
    if (!prismaHolder.client) {
      throw new Error("test prisma not set");
    }
    return prismaHolder.client;
  },
}));

import { postgresTest } from "@internal/testcontainers";

vi.setConfig({ testTimeout: 60_000 });

function randomHex(len = 12): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

async function seedInviteFixture(
  prisma: PrismaClient,
  opts: { activeProjectCount: number; deletedProjectCount?: number }
) {
  const suffix = randomHex(8);
  const inviter = await prisma.user.create({
    data: {
      email: `inviter-${suffix}@test.local`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  const invitee = await prisma.user.create({
    data: {
      email: `invitee-${suffix}@test.local`,
      authenticationMethod: "MAGIC_LINK",
    },
  });

  const organization = await prisma.organization.create({
    data: {
      title: `invite-org-${suffix}`,
      slug: `invite-org-${suffix}`,
      v3Enabled: true,
      members: { create: { userId: inviter.id, role: "ADMIN" } },
    },
  });

  const activeProjects = [];
  for (let i = 0; i < opts.activeProjectCount; i++) {
    activeProjects.push(
      await prisma.project.create({
        data: {
          name: `active-project-${i}-${suffix}`,
          slug: `active-proj-${i}-${suffix}`,
          externalRef: `proj_active_${i}_${suffix}`,
          organizationId: organization.id,
          engine: "V2",
        },
      })
    );
  }

  const deletedProjectCount = opts.deletedProjectCount ?? 0;
  for (let i = 0; i < deletedProjectCount; i++) {
    await prisma.project.create({
      data: {
        name: `deleted-project-${i}-${suffix}`,
        slug: `deleted-proj-${i}-${suffix}`,
        externalRef: `proj_deleted_${i}_${suffix}`,
        organizationId: organization.id,
        engine: "V2",
        deletedAt: new Date(),
      },
    });
  }

  const invite = await prisma.orgMemberInvite.create({
    data: {
      email: invitee.email,
      organizationId: organization.id,
      inviterId: inviter.id,
      role: "MEMBER",
    },
  });

  return { inviter, invitee, organization, activeProjects, invite };
}

function devEnvKeys(apiKey: string, pkApiKey: string) {
  return { apiKey, pkApiKey, shortcode: randomHex(4) };
}

describe("acceptInvite", () => {
  postgresTest(
    "creates member and dev environments for active projects only (many projects)",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite } = await import("../app/models/member.server");

      const { invitee, organization, activeProjects, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 25,
        deletedProjectCount: 3,
      });

      const beforeEnvCount = await prisma.runtimeEnvironment.count();

      const { organization: joinedOrg } = await acceptInvite({
        inviteId: invite.id,
        organizationId: organization.id,
        user: { id: invitee.id, email: invitee.email },
      });

      expect(joinedOrg.id).toBe(organization.id);

      const member = await prisma.orgMember.findFirst({
        where: { userId: invitee.id, organizationId: organization.id },
      });
      expect(member).not.toBeNull();

      const devEnvs = await prisma.runtimeEnvironment.findMany({
        where: {
          organizationId: organization.id,
          orgMemberId: member!.id,
          type: "DEVELOPMENT",
        },
      });
      expect(devEnvs).toHaveLength(activeProjects.length);

      const envProjectIds = new Set(devEnvs.map((e) => e.projectId));
      for (const project of activeProjects) {
        expect(envProjectIds.has(project.id)).toBe(true);
      }

      const newEnvCount = await prisma.runtimeEnvironment.count();
      expect(newEnvCount - beforeEnvCount).toBe(activeProjects.length);
    }
  );

  postgresTest(
    "rejects wrong email without creating member or environments",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite, INVITE_NOT_FOUND } = await import("../app/models/member.server");

      const { invitee, organization, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 2,
      });

      const beforeMemberCount = await prisma.orgMember.count({
        where: { organizationId: organization.id, userId: invitee.id },
      });
      const beforeEnvCount = await prisma.runtimeEnvironment.count();

      await expect(
        acceptInvite({
          inviteId: invite.id,
          user: { id: invitee.id, email: "wrong@example.com" },
        })
      ).rejects.toThrow(INVITE_NOT_FOUND);

      const afterMemberCount = await prisma.orgMember.count({
        where: { organizationId: organization.id, userId: invitee.id },
      });
      expect(afterMemberCount).toBe(beforeMemberCount);

      const afterEnvCount = await prisma.runtimeEnvironment.count();
      expect(afterEnvCount).toBe(beforeEnvCount);
    }
  );

  postgresTest(
    "rejects invite for deleted organization without creating member or environments",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite, INVITE_NOT_FOUND } = await import("../app/models/member.server");

      const { invitee, organization, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 2,
      });

      await prisma.organization.update({
        where: { id: organization.id },
        data: { deletedAt: new Date() },
      });

      const beforeMemberCount = await prisma.orgMember.count({
        where: { organizationId: organization.id, userId: invitee.id },
      });
      const beforeEnvCount = await prisma.runtimeEnvironment.count();

      await expect(
        acceptInvite({
          inviteId: invite.id,
          user: { id: invitee.id, email: invitee.email },
        })
      ).rejects.toThrow(INVITE_NOT_FOUND);

      const afterMemberCount = await prisma.orgMember.count({
        where: { organizationId: organization.id, userId: invitee.id },
      });
      expect(afterMemberCount).toBe(beforeMemberCount);

      const afterEnvCount = await prisma.runtimeEnvironment.count();
      expect(afterEnvCount).toBe(beforeEnvCount);
    }
  );

  postgresTest(
    "rejects already consumed invite with normalized error",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite, INVITE_NOT_FOUND } = await import("../app/models/member.server");

      const { invitee, organization, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 1,
      });

      await prisma.orgMemberInvite.delete({ where: { id: invite.id } });

      await expect(
        acceptInvite({
          inviteId: invite.id,
          user: { id: invitee.id, email: invitee.email },
        })
      ).rejects.toThrow(INVITE_NOT_FOUND);

      const member = await prisma.orgMember.findFirst({
        where: { userId: invitee.id, organizationId: organization.id },
      });
      expect(member).toBeNull();
    }
  );
});

describe("provisionMemberDevelopmentEnvironments", () => {
  postgresTest(
    "skips projects that already have development environments",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { provisionMemberDevelopmentEnvironments } =
        await import("../app/models/member.server");

      const { invitee, organization, activeProjects, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 3,
      });

      await prisma.orgMemberInvite.delete({ where: { id: invite.id } });

      const member = await prisma.orgMember.create({
        data: {
          organizationId: organization.id,
          userId: invitee.id,
          role: "MEMBER",
        },
      });

      const keys = devEnvKeys(`tr_dev_${randomHex(24)}`, `pk_dev_${randomHex(24)}`);
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          ...keys,
          projectId: activeProjects[1].id,
          organizationId: organization.id,
          orgMemberId: member.id,
        },
      });

      await provisionMemberDevelopmentEnvironments({
        inviteId: invite.id,
        user: { id: invitee.id, email: invitee.email },
        member,
        organization,
        projects: activeProjects,
        maximumConcurrencyLimit: 5,
      });

      const devEnvs = await prisma.runtimeEnvironment.findMany({
        where: {
          organizationId: organization.id,
          orgMemberId: member.id,
          type: "DEVELOPMENT",
        },
      });

      expect(devEnvs).toHaveLength(activeProjects.length);
    }
  );

  postgresTest(
    "throws partial-success error when env creation fails mid-loop",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { provisionMemberDevelopmentEnvironments, ENV_SETUP_INCOMPLETE } =
        await import("../app/models/member.server");

      const { invitee, organization, activeProjects, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 2,
      });

      await prisma.orgMemberInvite.delete({ where: { id: invite.id } });

      const member = await prisma.orgMember.create({
        data: {
          organizationId: organization.id,
          userId: invitee.id,
          role: "MEMBER",
        },
      });

      await expect(
        provisionMemberDevelopmentEnvironments({
          inviteId: invite.id,
          user: { id: invitee.id, email: invitee.email },
          member,
          organization,
          projects: [...activeProjects, { id: "missing-project-id" }],
          maximumConcurrencyLimit: 5,
        })
      ).rejects.toThrow(ENV_SETUP_INCOMPLETE);

      const devEnvs = await prisma.runtimeEnvironment.findMany({
        where: {
          organizationId: organization.id,
          orgMemberId: member.id,
          type: "DEVELOPMENT",
        },
      });

      const envProjectIds = devEnvs.map((env) => env.projectId);
      expect(envProjectIds).toContain(activeProjects[0].id);
      expect(envProjectIds).toContain(activeProjects[1].id);
    }
  );
});

describe("acceptInvite recovery", () => {
  postgresTest(
    "retries successfully when membership exists and the invite is still pending",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite } = await import("../app/models/member.server");

      const { invitee, organization, activeProjects, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 3,
      });

      const member = await prisma.orgMember.create({
        data: {
          organizationId: organization.id,
          userId: invitee.id,
          role: "MEMBER",
        },
      });

      const keys = devEnvKeys(`tr_dev_${randomHex(24)}`, `pk_dev_${randomHex(24)}`);
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          ...keys,
          projectId: activeProjects[0].id,
          organizationId: organization.id,
          orgMemberId: member.id,
        },
      });

      const { organization: joinedOrg } = await acceptInvite({
        inviteId: invite.id,
        organizationId: organization.id,
        user: { id: invitee.id, email: invitee.email },
      });

      expect(joinedOrg.id).toBe(organization.id);

      const devEnvs = await prisma.runtimeEnvironment.findMany({
        where: {
          organizationId: organization.id,
          orgMemberId: member.id,
          type: "DEVELOPMENT",
        },
      });
      expect(devEnvs).toHaveLength(activeProjects.length);

      const remainingInvite = await prisma.orgMemberInvite.findFirst({
        where: { id: invite.id },
      });
      expect(remainingInvite).toBeNull();
    }
  );

  postgresTest(
    "recovers when the invite was already consumed but development environments are incomplete",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite } = await import("../app/models/member.server");

      const { invitee, organization, activeProjects, invite } = await seedInviteFixture(prisma, {
        activeProjectCount: 3,
      });

      await prisma.orgMemberInvite.delete({ where: { id: invite.id } });

      const member = await prisma.orgMember.create({
        data: {
          organizationId: organization.id,
          userId: invitee.id,
          role: "MEMBER",
        },
      });

      const keys = devEnvKeys(`tr_dev_${randomHex(24)}`, `pk_dev_${randomHex(24)}`);
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          ...keys,
          projectId: activeProjects[0].id,
          organizationId: organization.id,
          orgMemberId: member.id,
        },
      });

      const { organization: joinedOrg } = await acceptInvite({
        inviteId: invite.id,
        organizationId: organization.id,
        user: { id: invitee.id, email: invitee.email },
      });

      expect(joinedOrg.id).toBe(organization.id);

      const devEnvs = await prisma.runtimeEnvironment.findMany({
        where: {
          organizationId: organization.id,
          orgMemberId: member.id,
          type: "DEVELOPMENT",
        },
      });
      expect(devEnvs).toHaveLength(activeProjects.length);
    }
  );

  postgresTest(
    "does not recover unrelated memberships when invite is missing and organizationId is omitted",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite, INVITE_NOT_FOUND } = await import("../app/models/member.server");

      const fixtureA = await seedInviteFixture(prisma, { activeProjectCount: 2 });
      const fixtureB = await seedInviteFixture(prisma, { activeProjectCount: 2 });

      await prisma.orgMemberInvite.delete({ where: { id: fixtureA.invite.id } });

      const member = await prisma.orgMember.create({
        data: {
          organizationId: fixtureA.organization.id,
          userId: fixtureA.invitee.id,
          role: "MEMBER",
        },
      });

      const keys = devEnvKeys(`tr_dev_${randomHex(24)}`, `pk_dev_${randomHex(24)}`);
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          ...keys,
          projectId: fixtureA.activeProjects[0].id,
          organizationId: fixtureA.organization.id,
          orgMemberId: member.id,
        },
      });

      await expect(
        acceptInvite({
          inviteId: fixtureA.invite.id,
          user: { id: fixtureA.invitee.id, email: fixtureA.invitee.email },
        })
      ).rejects.toThrow(INVITE_NOT_FOUND);

      const devEnvs = await prisma.runtimeEnvironment.findMany({
        where: {
          organizationId: fixtureA.organization.id,
          orgMemberId: member.id,
          type: "DEVELOPMENT",
        },
      });
      expect(devEnvs).toHaveLength(1);
      expect(fixtureB.invite.id).not.toBe(fixtureA.invite.id);
    }
  );

  postgresTest(
    "does not recover memberships for a different organizationId than the stale invite",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite, INVITE_NOT_FOUND } = await import("../app/models/member.server");

      const fixtureA = await seedInviteFixture(prisma, { activeProjectCount: 2 });
      const fixtureB = await seedInviteFixture(prisma, { activeProjectCount: 2 });

      await prisma.orgMemberInvite.delete({ where: { id: fixtureA.invite.id } });

      const member = await prisma.orgMember.create({
        data: {
          organizationId: fixtureA.organization.id,
          userId: fixtureA.invitee.id,
          role: "MEMBER",
        },
      });

      const keys = devEnvKeys(`tr_dev_${randomHex(24)}`, `pk_dev_${randomHex(24)}`);
      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "DEVELOPMENT",
          ...keys,
          projectId: fixtureA.activeProjects[0].id,
          organizationId: fixtureA.organization.id,
          orgMemberId: member.id,
        },
      });

      await expect(
        acceptInvite({
          inviteId: fixtureA.invite.id,
          organizationId: fixtureB.organization.id,
          user: { id: fixtureA.invitee.id, email: fixtureA.invitee.email },
        })
      ).rejects.toThrow(INVITE_NOT_FOUND);

      const devEnvs = await prisma.runtimeEnvironment.findMany({
        where: {
          organizationId: fixtureA.organization.id,
          orgMemberId: member.id,
          type: "DEVELOPMENT",
        },
      });
      expect(devEnvs).toHaveLength(1);
    }
  );
});
