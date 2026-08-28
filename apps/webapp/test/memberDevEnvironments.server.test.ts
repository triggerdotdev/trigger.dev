import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";

const prismaHolder = vi.hoisted(() => ({
  client: null as PrismaClient | null,
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    getUserRole: async () => null,
    setUserRole: async () => ({ ok: true }),
  },
}));

const workerHolder = vi.hoisted(() => ({
  calls: [] as Array<{ id: string; job: string; payload: unknown }>,
  shouldThrow: false,
}));
vi.mock("~/v3/commonWorker.server", () => ({
  commonWorker: {
    enqueueOnce: async (args: { id: string; job: string; payload: unknown }) => {
      if (workerHolder.shouldThrow) {
        throw new Error("redis unavailable");
      }
      workerHolder.calls.push(args);
    },
  },
}));

vi.mock("~/db.server", async () => {
  const { Prisma } = await import("@trigger.dev/database");

  return {
    Prisma,
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
  };
});

import { postgresTest } from "@internal/testcontainers";

vi.setConfig({ testTimeout: 60_000 });

function randomHex(len = 12): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

async function seedMembershipFixture(
  prisma: PrismaClient,
  opts: { activeProjectCount: number; deletedProjectCount?: number }
) {
  const suffix = randomHex(8);

  const user = await prisma.user.create({
    data: {
      email: `member-${suffix}@test.local`,
      authenticationMethod: "SSO",
    },
  });

  const organization = await prisma.organization.create({
    data: {
      title: `sso-org-${suffix}`,
      slug: `sso-org-${suffix}`,
      isActivated: true,
      members: { create: { userId: user.id, role: "MEMBER" } },
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

  for (let i = 0; i < (opts.deletedProjectCount ?? 0); i++) {
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

  return { user, organization, activeProjects };
}

function devEnvironmentsFor(prisma: PrismaClient, organizationId: string) {
  return prisma.runtimeEnvironment.findMany({
    where: { organizationId, type: "DEVELOPMENT" },
    select: { projectId: true, orgMemberId: true, slug: true },
  });
}

describe("provisionDevEnvironmentsForMembership", () => {
  postgresTest("creates a development environment for every active project", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { provisionDevEnvironmentsForMembership } =
      await import("../app/services/memberDevEnvironments.server");

    const { user, organization, activeProjects } = await seedMembershipFixture(prisma, {
      activeProjectCount: 3,
    });

    await provisionDevEnvironmentsForMembership({
      userId: user.id,
      organizationId: organization.id,
      source: "sso_jit",
    });

    const devEnvs = await devEnvironmentsFor(prisma, organization.id);
    const member = await prisma.orgMember.findFirstOrThrow({
      where: { userId: user.id, organizationId: organization.id },
    });

    expect(devEnvs.map((env) => env.projectId).sort()).toEqual(
      activeProjects.map((project) => project.id).sort()
    );
    expect(devEnvs.every((env) => env.orgMemberId === member.id)).toBe(true);
    expect(devEnvs.every((env) => env.slug === "dev")).toBe(true);
  });

  postgresTest("skips soft-deleted projects", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { provisionDevEnvironmentsForMembership } =
      await import("../app/services/memberDevEnvironments.server");

    const { user, organization, activeProjects } = await seedMembershipFixture(prisma, {
      activeProjectCount: 2,
      deletedProjectCount: 2,
    });

    await provisionDevEnvironmentsForMembership({
      userId: user.id,
      organizationId: organization.id,
      source: "directory_sync",
    });

    const devEnvs = await devEnvironmentsFor(prisma, organization.id);

    expect(devEnvs.map((env) => env.projectId).sort()).toEqual(
      activeProjects.map((project) => project.id).sort()
    );
  });

  postgresTest("creates no duplicates when it runs again", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { provisionDevEnvironmentsForMembership } =
      await import("../app/services/memberDevEnvironments.server");

    const { user, organization, activeProjects } = await seedMembershipFixture(prisma, {
      activeProjectCount: 2,
    });

    const payload = {
      userId: user.id,
      organizationId: organization.id,
      source: "sso_jit" as const,
    };

    await provisionDevEnvironmentsForMembership(payload);
    await provisionDevEnvironmentsForMembership(payload);

    const devEnvs = await devEnvironmentsFor(prisma, organization.id);

    expect(devEnvs).toHaveLength(activeProjects.length);
  });

  postgresTest("creates only the environments that are missing", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { provisionDevEnvironmentsForMembership } =
      await import("../app/services/memberDevEnvironments.server");

    const { user, organization, activeProjects } = await seedMembershipFixture(prisma, {
      activeProjectCount: 3,
    });
    const member = await prisma.orgMember.findFirstOrThrow({
      where: { userId: user.id, organizationId: organization.id },
    });

    const existing = await prisma.runtimeEnvironment.create({
      data: {
        slug: "dev",
        type: "DEVELOPMENT",
        apiKey: `tr_dev_${randomHex(24)}`,
        pkApiKey: `pk_dev_${randomHex(24)}`,
        shortcode: randomHex(4),
        projectId: activeProjects[1].id,
        organizationId: organization.id,
        orgMemberId: member.id,
      },
    });

    await provisionDevEnvironmentsForMembership({
      userId: user.id,
      organizationId: organization.id,
      source: "sso_jit",
    });

    const devEnvs = await prisma.runtimeEnvironment.findMany({
      where: { organizationId: organization.id, type: "DEVELOPMENT" },
      select: { id: true, projectId: true },
    });

    expect(devEnvs).toHaveLength(activeProjects.length);
    expect(devEnvs.find((env) => env.projectId === activeProjects[1].id)?.id).toBe(existing.id);
  });

  postgresTest("does nothing when the membership no longer exists", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { provisionDevEnvironmentsForMembership } =
      await import("../app/services/memberDevEnvironments.server");

    const { user, organization } = await seedMembershipFixture(prisma, {
      activeProjectCount: 2,
    });

    await prisma.orgMember.deleteMany({
      where: { userId: user.id, organizationId: organization.id },
    });

    await expect(
      provisionDevEnvironmentsForMembership({
        userId: user.id,
        organizationId: organization.id,
        source: "directory_sync",
      })
    ).resolves.toBeUndefined();

    expect(await devEnvironmentsFor(prisma, organization.id)).toHaveLength(0);
  });
});

describe("createDevelopmentEnvironmentForMember", () => {
  postgresTest("creates the environment when the member has none", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { createDevelopmentEnvironmentForMember } =
      await import("../app/models/organization.server");

    const { user, organization, activeProjects } = await seedMembershipFixture(prisma, {
      activeProjectCount: 1,
    });
    const member = await prisma.orgMember.findFirstOrThrow({
      where: { userId: user.id, organizationId: organization.id },
    });

    const result = await createDevelopmentEnvironmentForMember({
      organization,
      project: activeProjects[0],
      member,
      maximumConcurrencyLimit: 5,
    });

    expect(result.created).toBe(true);
    expect(await devEnvironmentsFor(prisma, organization.id)).toHaveLength(1);
  });

  postgresTest(
    "treats a concurrently created environment as already provisioned",
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { createDevelopmentEnvironmentForMember } =
        await import("../app/models/organization.server");

      const { user, organization, activeProjects } = await seedMembershipFixture(prisma, {
        activeProjectCount: 1,
      });
      const member = await prisma.orgMember.findFirstOrThrow({
        where: { userId: user.id, organizationId: organization.id },
      });

      const args = {
        organization,
        project: activeProjects[0],
        member,
        maximumConcurrencyLimit: 5,
      };

      const results = await Promise.all([
        createDevelopmentEnvironmentForMember(args),
        createDevelopmentEnvironmentForMember(args),
      ]);

      expect(results.filter((result) => result.created)).toHaveLength(1);
      expect(results.filter((result) => !result.created)).toHaveLength(1);
      expect(await devEnvironmentsFor(prisma, organization.id)).toHaveLength(1);
    }
  );

  postgresTest(
    "rethrows when the conflict is not a development environment",
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { createDevelopmentEnvironmentForMember } =
        await import("../app/models/organization.server");

      const { user, organization, activeProjects } = await seedMembershipFixture(prisma, {
        activeProjectCount: 1,
      });
      const member = await prisma.orgMember.findFirstOrThrow({
        where: { userId: user.id, organizationId: organization.id },
      });

      await prisma.runtimeEnvironment.create({
        data: {
          slug: "dev",
          type: "STAGING",
          apiKey: `tr_stg_${randomHex(24)}`,
          pkApiKey: `pk_stg_${randomHex(24)}`,
          shortcode: randomHex(4),
          projectId: activeProjects[0].id,
          organizationId: organization.id,
          orgMemberId: member.id,
        },
      });

      await expect(
        createDevelopmentEnvironmentForMember({
          organization,
          project: activeProjects[0],
          member,
          maximumConcurrencyLimit: 5,
        })
      ).rejects.toThrow();
    }
  );
});

describe("enqueueMemberDevelopmentEnvironments", () => {
  beforeEach(() => {
    workerHolder.calls.length = 0;
    workerHolder.shouldThrow = false;
  });

  it("dedupes by organization and user so repeat sign-ins collapse", async () => {
    const { enqueueMemberDevelopmentEnvironments } =
      await import("../app/services/memberDevEnvironments.server");

    const result = await enqueueMemberDevelopmentEnvironments({
      userId: "user_1",
      organizationId: "org_1",
      source: "sso_jit",
    });

    expect(result).toEqual({ enqueued: true });
    expect(workerHolder.calls).toEqual([
      {
        id: "membership:devEnvs:org_1:user_1",
        job: "membership.provisionDevEnvironments",
        payload: { userId: "user_1", organizationId: "org_1", source: "sso_jit" },
      },
    ]);
  });

  it("reports a queue failure instead of throwing", async () => {
    const { enqueueMemberDevelopmentEnvironments } =
      await import("../app/services/memberDevEnvironments.server");
    workerHolder.shouldThrow = true;

    const result = await enqueueMemberDevelopmentEnvironments({
      userId: "user_1",
      organizationId: "org_1",
      source: "directory_sync",
    });

    expect(result).toEqual({ enqueued: false });
  });
});

describe("membership source schema", () => {
  it("accepts every membership source the job can be enqueued with", async () => {
    const { MembershipSourceSchema } = await import("../app/models/member.server");
    const { MembershipDevEnvironmentsSchema } =
      await import("../app/services/memberDevEnvironments.server");

    for (const source of MembershipSourceSchema.options) {
      const parsed = MembershipDevEnvironmentsSchema.safeParse({
        userId: "user_1",
        organizationId: "org_1",
        source,
      });
      expect(parsed.success, `source "${source}" must be accepted by the job schema`).toBe(true);
    }
  });
});
