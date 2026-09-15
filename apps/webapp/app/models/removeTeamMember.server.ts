import type { PrismaClient } from "@trigger.dev/database";
import { ServiceValidationError } from "~/v3/services/common.server";

// Leaf module with a type-only Prisma import (caller passes the client) so it
// can be unit-tested without importing `~/db.server`, which eagerly connects
// the global prisma singleton. ServiceValidationError is a plain error class
// with no imports, so it stays leaf-safe and lets callers map it to a status.
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
    throw new ServiceValidationError("User does not have access to this organization", 403);
  }

  // Serializable so the "keep at least one member" check and the delete are
  // atomic: at ReadCommitted two concurrent removals could each see >1 member
  // and both delete, orphaning the org. The guard lives here, not per-caller,
  // so every surface (dashboard + management API) is TOCTOU-safe. Raw
  // $transaction (not the ~/db.server helper) keeps this module leaf/testable.
  return prismaClient.$transaction(
    async (tx) => {
      // Scope both the lookup and the delete to org.id, so the member id is
      // only ever resolved within the actor's organization.
      const target = await tx.orgMember.findFirst({
        where: { id: memberId, organizationId: org.id },
        include: { organization: true, user: true },
      });

      if (!target) {
        throw new ServiceValidationError("Member not found in this organization", 404);
      }

      const memberCount = await tx.orgMember.count({ where: { organizationId: org.id } });
      if (memberCount <= 1) {
        throw new ServiceValidationError("Cannot remove the last member of an organization", 400);
      }

      await tx.orgMember.delete({ where: { id: target.id } });
      return target;
    },
    { isolationLevel: "Serializable" }
  );
}
