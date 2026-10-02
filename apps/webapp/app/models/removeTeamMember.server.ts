import type { PrismaClient } from "@trigger.dev/database";
import { $transaction } from "~/db.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { deleteOrgMember } from "./deleteOrgMember.server";
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
  // so every surface (dashboard + management API) is TOCTOU-safe.
  const result = await $transaction(
    prismaClient,
    "remove team member",
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

      await deleteOrgMember(tx, { id: target.id, organizationId: org.id });
      return target;
    },
    { isolationLevel: "Serializable" }
  );
  if (!result) {
    throw new Error("Failed to remove organization member");
  }
  return result;
}
