import type { PrismaClient } from "@trigger.dev/database";
import { $transaction } from "~/db.server";
import { enqueueAttioMemberSync } from "~/services/attio.server";
import { auditLogs } from "~/services/auditLogs/auditLogs.server";
import { rbac } from "~/services/rbac.server";
import {
  recordMemberRemovalCredentials,
  userActor,
} from "~/services/credentialFingerprints.server";
import { ServiceValidationError } from "~/v3/services/common.server";
import { deleteOrgMember, prepareMemberRemovalKeys } from "./deleteOrgMember.server";
import { memberAuditTarget } from "./memberAudit.server";
import { isOwnerRole } from "./orgMember.server";
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

  // Checked again inside the transaction, which is what makes them race-free. Checking here first
  // keeps a removal that would be rejected from saving fingerprints for keys it never issues.
  const currentMembers = await prismaClient.orgMember.findMany({
    where: { organizationId: org.id },
    select: { id: true, userId: true },
  });
  const currentTarget = currentMembers.find((m) => m.id === memberId);
  if (!currentTarget) {
    throw new ServiceValidationError("Member not found in this organization", 404);
  }
  if (currentMembers.length <= 1) {
    throw new ServiceValidationError("Cannot remove the last member of an organization", 400);
  }
  await assertOrgKeepsAnOwner(org.id, currentMembers, currentTarget.userId);

  // The new development keys' fingerprints are saved first: a failed save fails the removal.
  const actor = userActor(userId);
  const newKeys = await prepareMemberRemovalKeys(
    prismaClient,
    { id: memberId, organizationId: org.id },
    actor
  );

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

      const members = await tx.orgMember.findMany({
        where: { organizationId: org.id },
        select: { userId: true },
      });
      if (members.length <= 1) {
        throw new ServiceValidationError("Cannot remove the last member of an organization", 400);
      }

      await assertOrgKeepsAnOwner(org.id, members, target.userId);

      const { credentials } = await deleteOrgMember(
        tx,
        { id: target.id, organizationId: org.id },
        newKeys
      );
      return { target, credentials };
    },
    { isolationLevel: "Serializable" }
  );
  if (!result) {
    throw new Error("Failed to remove organization member");
  }
  recordMemberRemovalCredentials(result.credentials, actor);
  await enqueueAttioMemberSync({ organizationId: org.id, userId: result.target.userId });
  auditLogs.record({
    category: "members",
    action: "member.removed",
    organizationId: org.id,
    target: memberAuditTarget(result.target),
  });
  return result.target;
}

/**
 * The org must keep an Owner, the same guard removeOrgMemberForDirectory applies. A no-op without
 * an RBAC plugin, where nobody holds Owner.
 */
async function assertOrgKeepsAnOwner(
  organizationId: string,
  members: { userId: string }[],
  targetUserId: string
) {
  const roles = await rbac.getUserRoles(
    members.map((m) => m.userId),
    organizationId
  );
  const isOwner = (memberUserId: string) => isOwnerRole(roles.get(memberUserId) ?? null);
  if (
    isOwner(targetUserId) &&
    !members.some((m) => m.userId !== targetUserId && isOwner(m.userId))
  ) {
    throw new ServiceValidationError(
      "An organization needs at least one Owner. Make someone else an Owner first.",
      400
    );
  }
}
