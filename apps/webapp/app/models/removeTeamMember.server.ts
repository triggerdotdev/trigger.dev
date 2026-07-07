import type { PrismaClient } from "@trigger.dev/database";

// Leaf module with a type-only Prisma import (caller passes the client) so it
// can be unit-tested without importing `~/db.server`, which eagerly connects
// the global prisma singleton.
export async function removeTeamMember(
  {
    userId,
    slug,
    memberId,
  }: {
    userId: string;
    slug: string;
    memberId: string;
  },
  prismaClient: PrismaClient
) {
  const org = await prismaClient.organization.findFirst({
    where: { slug, members: { some: { userId } } },
  });

  if (!org) {
    throw new Error("User does not have access to this organization");
  }

  // Scope both the lookup and the delete to org.id, in a transaction, so the
  // member id is only ever resolved within the actor's organization.
  return prismaClient.$transaction(async (tx) => {
    const target = await tx.orgMember.findFirst({
      where: { id: memberId, organizationId: org.id },
      include: { organization: true, user: true },
    });

    if (!target) {
      throw new Error("Member not found in this organization");
    }

    await tx.orgMember.delete({ where: { id: target.id } });
    return target;
  });
}
