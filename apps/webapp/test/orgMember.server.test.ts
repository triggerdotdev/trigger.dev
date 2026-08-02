import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, vi } from "vitest";
import type { PrismaClient } from "@trigger.dev/database";

const prismaHolder = vi.hoisted(() => ({
  client: null as PrismaClient | null,
}));

type SetUserRoleResult = { ok: true } | { ok: false; error: string; code?: "last_owner" };

const rbacHolder = vi.hoisted(() => ({
  setUserRoleResult: { ok: true } as SetUserRoleResult,
  currentRole: null as { id: string } | null,
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    getUserRole: async () => rbacHolder.currentRole,
    setUserRole: async () => rbacHolder.setUserRoleResult,
  },
}));

const enqueueHolder = vi.hoisted(() => ({
  calls: [] as unknown[],
  enqueued: true,
}));
vi.mock("~/services/memberDevEnvironments.server", () => ({
  enqueueMemberDevelopmentEnvironments: async (payload: unknown) => {
    enqueueHolder.calls.push(payload);
    return { enqueued: enqueueHolder.enqueued };
  },
}));
const enqueueCalls = enqueueHolder.calls;

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

beforeEach(() => {
  enqueueCalls.length = 0;
  enqueueHolder.enqueued = true;
  rbacHolder.setUserRoleResult = { ok: true };
  rbacHolder.currentRole = null;
});

function randomHex(len = 12): string {
  return randomBytes(Math.ceil(len / 2))
    .toString("hex")
    .slice(0, len);
}

async function seedUserAndOrg(prisma: PrismaClient) {
  const suffix = randomHex(8);

  const owner = await prisma.user.create({
    data: { email: `owner-${suffix}@test.local`, authenticationMethod: "MAGIC_LINK" },
  });
  const user = await prisma.user.create({
    data: { email: `joiner-${suffix}@test.local`, authenticationMethod: "SSO" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: `jit-org-${suffix}`,
      slug: `jit-org-${suffix}`,
      isActivated: true,
      members: { create: { userId: owner.id, role: "ADMIN" } },
    },
  });

  return { user, organization };
}

describe("ensureOrgMember development environment provisioning", () => {
  postgresTest("queues provisioning for a newly created membership", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { ensureOrgMember } = await import("../app/models/orgMember.server");

    const { user, organization } = await seedUserAndOrg(prisma);

    const result = await ensureOrgMember({
      userId: user.id,
      organizationId: organization.id,
      roleId: null,
      source: "sso_jit",
    });

    expect(result.created).toBe(true);
    expect(enqueueCalls).toEqual([
      { userId: user.id, organizationId: organization.id, source: "sso_jit" },
    ]);
  });

  postgresTest("queues provisioning for a membership that already exists", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { ensureOrgMember } = await import("../app/models/orgMember.server");

    const { user, organization } = await seedUserAndOrg(prisma);
    await prisma.orgMember.create({
      data: { userId: user.id, organizationId: organization.id, role: "MEMBER" },
    });

    const result = await ensureOrgMember({
      userId: user.id,
      organizationId: organization.id,
      roleId: null,
      source: "directory_sync",
    });

    expect(result.created).toBe(false);
    expect(enqueueCalls).toEqual([
      { userId: user.id, organizationId: organization.id, source: "directory_sync" },
    ]);
  });

  postgresTest(
    "does not queue provisioning when the membership is rolled back",
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { ensureOrgMember } = await import("../app/models/orgMember.server");

      const { user, organization } = await seedUserAndOrg(prisma);
      rbacHolder.setUserRoleResult = { ok: false, error: "role service unavailable" };

      await expect(
        ensureOrgMember({
          userId: user.id,
          organizationId: organization.id,
          roleId: "role_restricted",
          source: "sso_jit",
        })
      ).rejects.toThrow(/failed to apply role/);

      const member = await prisma.orgMember.findFirst({
        where: { userId: user.id, organizationId: organization.id },
      });
      expect(member).toBeNull();
      expect(enqueueCalls).toEqual([]);
    }
  );

  postgresTest("reports a failed enqueue without failing the membership", async ({ prisma }) => {
    prismaHolder.client = prisma;
    const { ensureOrgMember } = await import("../app/models/orgMember.server");

    const { user, organization } = await seedUserAndOrg(prisma);
    enqueueHolder.enqueued = false;

    const result = await ensureOrgMember({
      userId: user.id,
      organizationId: organization.id,
      roleId: null,
      source: "directory_sync",
    });

    expect(result).toMatchObject({ created: true, devEnvironmentsQueued: false });

    const member = await prisma.orgMember.findFirst({
      where: { userId: user.id, organizationId: organization.id },
    });
    expect(member).not.toBeNull();
  });
});
