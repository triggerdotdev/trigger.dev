import { randomBytes } from "node:crypto";
import { describe, expect, vi } from "vitest";
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

// The invite is stored with different casing to the invitee's account email,
// which is the shape users hit when an admin types the address by hand.
async function seedMixedCaseInvite(prisma: PrismaClient) {
  const suffix = randomHex(8);
  const accountEmail = `invitee-${suffix}@example.test`;
  const invitedAs = `Invitee-${suffix}@Example.Test`;

  const inviter = await prisma.user.create({
    data: {
      email: `inviter-${suffix}@example.test`,
      authenticationMethod: "MAGIC_LINK",
    },
  });
  const invitee = await prisma.user.create({
    data: { email: accountEmail, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: {
      title: `invite-case-org-${suffix}`,
      slug: `invite-case-org-${suffix}`,
      isActivated: true,
      members: { create: { userId: inviter.id, role: "ADMIN" } },
    },
  });
  const invite = await prisma.orgMemberInvite.create({
    data: {
      email: invitedAs,
      organizationId: organization.id,
      inviterId: inviter.id,
      role: "MEMBER",
    },
  });

  return { inviter, invitee, organization, invite, accountEmail, invitedAs };
}

describe("invite email casing", () => {
  postgresTest(
    "getUsersInvites returns an invite stored with different casing",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { getUsersInvites } = await import("../app/models/member.server");

      const { invite, accountEmail, invitedAs } = await seedMixedCaseInvite(prisma);
      expect(invitedAs).not.toBe(accountEmail);

      const invites = await getUsersInvites({ email: accountEmail });

      expect(invites.map((i) => i.id)).toContain(invite.id);
    }
  );

  postgresTest(
    "acceptInvite joins the org and consumes an invite stored with different casing",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite } = await import("../app/models/member.server");

      const { invitee, organization, invite, accountEmail } = await seedMixedCaseInvite(prisma);

      const { organization: joined } = await acceptInvite({
        inviteId: invite.id,
        organizationId: organization.id,
        user: { id: invitee.id, email: accountEmail },
      });
      expect(joined.id).toBe(organization.id);

      const member = await prisma.orgMember.findFirst({
        where: { userId: invitee.id, organizationId: organization.id },
      });
      expect(member).not.toBeNull();

      // The delete filters on email through an extended unique where, and its
      // P2025 is swallowed by the caller, so a filter that stopped matching
      // would leave the invite behind while every other assertion still passed.
      const leftover = await prisma.orgMemberInvite.findUnique({ where: { id: invite.id } });
      expect(leftover).toBeNull();
    }
  );

  postgresTest(
    "declineInvite consumes an invite stored with different casing",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { declineInvite } = await import("../app/models/member.server");

      const { invitee, invite, accountEmail } = await seedMixedCaseInvite(prisma);

      await declineInvite({
        inviteId: invite.id,
        user: { id: invitee.id, email: accountEmail },
      });

      const leftover = await prisma.orgMemberInvite.findUnique({ where: { id: invite.id } });
      expect(leftover).toBeNull();
    }
  );

  postgresTest(
    "case-insensitive matching still rejects a genuinely different email",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { acceptInvite, INVITE_NOT_FOUND } = await import("../app/models/member.server");

      const { invitee, organization, invite } = await seedMixedCaseInvite(prisma);

      // The email filter is what stops one user accepting another's invite by
      // id. Folding case must not widen it into matching anything.
      await expect(
        acceptInvite({
          inviteId: invite.id,
          organizationId: organization.id,
          user: { id: invitee.id, email: "someone-else@example.test" },
        })
      ).rejects.toThrow(INVITE_NOT_FOUND);

      const stillThere = await prisma.orgMemberInvite.findUnique({ where: { id: invite.id } });
      expect(stillThere).not.toBeNull();
    }
  );
  postgresTest(
    "inviteMembers does not re-invite a member whose account email differs only by case",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { inviteMembers } = await import("../app/models/member.server");

      const suffix = randomHex(8);
      const owner = await prisma.user.create({
        data: { email: `owner-${suffix}@example.test`, authenticationMethod: "MAGIC_LINK" },
      });
      const member = await prisma.user.create({
        data: { email: `Member-${suffix}@Example.test`, authenticationMethod: "MAGIC_LINK" },
      });
      const organization = await prisma.organization.create({
        data: {
          title: `invite-dupe-org-${suffix}`,
          slug: `invite-dupe-org-${suffix}`,
          isActivated: true,
          members: {
            create: [
              { userId: owner.id, role: "ADMIN" },
              { userId: member.id, role: "MEMBER" },
            ],
          },
        },
      });

      // Both entry points fold the address before it reaches inviteMembers, so
      // this is what an admin typing the member's own address actually sends.
      const result = await inviteMembers({
        slug: organization.slug,
        emails: [`member-${suffix}@example.test`],
        userId: owner.id,
      });

      expect(result.created).toHaveLength(0);
      expect(result.alreadyMembers).toHaveLength(1);
    }
  );

  postgresTest(
    "inviteMembers does not duplicate a pending invite that differs only by case",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { inviteMembers } = await import("../app/models/member.server");

      const { organization, inviter, invitee, accountEmail } = await seedMixedCaseInvite(prisma);
      void invitee;

      const before = await prisma.orgMemberInvite.count({
        where: { organizationId: organization.id },
      });

      const result = await inviteMembers({
        slug: organization.slug,
        emails: [accountEmail],
        userId: inviter.id,
      });

      expect(result.created).toHaveLength(0);
      expect(result.alreadyInvited).toHaveLength(1);

      const after = await prisma.orgMemberInvite.count({
        where: { organizationId: organization.id },
      });
      expect(after).toBe(before);
    }
  );
  postgresTest(
    "inviteMembers stores addresses folded so the unique constraint can backstop",
    { timeout: 60_000 },
    async ({ prisma }) => {
      prismaHolder.client = prisma;
      const { inviteMembers } = await import("../app/models/member.server");

      const suffix = randomHex(8);
      const owner = await prisma.user.create({
        data: { email: `owner-${suffix}@example.test`, authenticationMethod: "MAGIC_LINK" },
      });
      const organization = await prisma.organization.create({
        data: {
          title: `invite-fold-org-${suffix}`,
          slug: `invite-fold-org-${suffix}`,
          isActivated: true,
          members: { create: { userId: owner.id, role: "ADMIN" } },
        },
      });

      // Called directly with mixed case, i.e. not relying on a route to
      // normalise first, since the constraint is the last line of defence.
      const first = await inviteMembers({
        slug: organization.slug,
        emails: [`Fresh-${suffix}@Example.Test`],
        userId: owner.id,
      });
      expect(first.created).toHaveLength(1);
      expect(first.created[0].email).toBe(`fresh-${suffix}@example.test`);

      // A differently cased variant must not become a second row.
      const second = await inviteMembers({
        slug: organization.slug,
        emails: [`FRESH-${suffix}@EXAMPLE.TEST`],
        userId: owner.id,
      });
      expect(second.created).toHaveLength(0);

      const rows = await prisma.orgMemberInvite.count({
        where: { organizationId: organization.id },
      });
      expect(rows).toBe(1);
    }
  );
});
