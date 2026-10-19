import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { feedbackOrganization } from "./feedbackOrganization.server";

async function createUser(prisma: PrismaClient, name: string) {
  return prisma.user.create({
    data: { email: `${name}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
}

async function createOrg(prisma: PrismaClient, slug: string, memberIds: string[]) {
  return prisma.organization.create({
    data: {
      title: `Org ${slug}`,
      slug,
      members: { create: memberIds.map((userId) => ({ userId })) },
    },
  });
}

describe("feedbackOrganization", () => {
  postgresTest("uses the org page the message was sent from", async ({ prisma }) => {
    const user = await createUser(prisma, "multi");
    const a = await createOrg(prisma, "org-a", [user.id]);
    await createOrg(prisma, "org-b", [user.id]);

    const org = await feedbackOrganization(
      user.id,
      "/orgs/org-a/projects/p/env/dev/runs",
      prisma,
      prisma
    );
    expect(org).toEqual({ id: a.id, title: a.title });
  });

  postgresTest("never resolves an org the user isn't a member of", async ({ prisma }) => {
    const user = await createUser(prisma, "member");
    const other = await createUser(prisma, "other");
    await createOrg(prisma, "mine", [user.id]);
    await createOrg(prisma, "theirs", [other.id]);

    expect(await feedbackOrganization(user.id, "/orgs/theirs", prisma, prisma)).toBeUndefined();
  });

  postgresTest("falls back to the user's only org outside an org page", async ({ prisma }) => {
    const user = await createUser(prisma, "single");
    const only = await createOrg(prisma, "only", [user.id]);

    expect(await feedbackOrganization(user.id, "/account", prisma, prisma)).toEqual({
      id: only.id,
      title: only.title,
    });
  });

  postgresTest("leaves it unattributed when the org is ambiguous", async ({ prisma }) => {
    const user = await createUser(prisma, "ambiguous");
    await createOrg(prisma, "first", [user.id]);
    await createOrg(prisma, "second", [user.id]);

    expect(await feedbackOrganization(user.id, "/account", prisma, prisma)).toBeUndefined();
  });

  postgresTest("finds a just-created org the replica hasn't caught up on", async ({ prisma }) => {
    const user = await createUser(prisma, "lagged");

    // The org exists only inside an uncommitted transaction: the transaction stands in for the
    // primary, and the plain client for a replica that can't see it yet.
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.organization.create({
        data: { title: "Org fresh", slug: "fresh", members: { create: [{ userId: user.id }] } },
      });
      expect(await feedbackOrganization(user.id, "/orgs/fresh", prisma, prisma)).toBeUndefined();
      expect(await feedbackOrganization(user.id, "/orgs/fresh", prisma, tx)).toEqual({
        id: fresh.id,
        title: fresh.title,
      });
    });
  });

  postgresTest("ignores deleted orgs", async ({ prisma }) => {
    const user = await createUser(prisma, "deleted");
    const gone = await createOrg(prisma, "gone", [user.id]);
    const live = await createOrg(prisma, "live", [user.id]);
    await prisma.organization.update({ where: { id: gone.id }, data: { deletedAt: new Date() } });

    expect(await feedbackOrganization(user.id, "/orgs/gone", prisma, prisma)).toBeUndefined();
    expect(await feedbackOrganization(user.id, "/account", prisma, prisma)).toEqual({
      id: live.id,
      title: live.title,
    });
  });
});
