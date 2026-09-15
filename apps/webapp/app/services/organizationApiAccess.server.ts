import { prisma } from "~/db.server";

/**
 * Resolve an org from a PAT-authenticated request's `$orgParam` (id or slug),
 * scoped to the caller's membership. This membership floor matters: the OSS
 * RBAC fallback grants a permissive ability to any PAT, so it can't be relied
 * on to reject non-members — resolving through the membership relation does.
 */
export async function resolveOrganizationForApiUser({
  orgParam,
  userId,
}: {
  orgParam: string;
  userId: string;
}): Promise<{ id: string; slug: string } | null> {
  return prisma.organization.findFirst({
    where: {
      OR: [{ id: orgParam }, { slug: orgParam }],
      deletedAt: null,
      members: { some: { userId } },
    },
    select: { id: true, slug: true },
  });
}
