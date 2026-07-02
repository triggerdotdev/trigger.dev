import { json } from "@remix-run/server-runtime";
import { isUserActorToken } from "@trigger.dev/rbac";
import { prisma } from "~/db.server";
import { rbac } from "~/services/rbac.server";

type OrganizationScopedResource = "members";

const RESOURCE_LABELS: Record<OrganizationScopedResource, string> = {
  members: "members",
};

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

/**
 * Org-tier RBAC for organization-scoped management API routes (team members,
 * invites). A personal access token (or delegated user-actor token) carries a
 * user, so enforce that user's role for the target org — mirroring the
 * dashboard's `manage:members` / `read:members` gates on the same operations.
 *
 * Returns a `Response` to short-circuit with when access is denied, or
 * `undefined` when the request may proceed.
 */
export async function authorizePatOrganizationAccess({
  request,
  organizationId,
  resource,
  action,
}: {
  request: Request;
  organizationId: string;
  resource: OrganizationScopedResource;
  action: "read" | "manage";
}): Promise<Response | undefined> {
  const bearer = request.headers
    .get("Authorization")
    ?.replace(/^Bearer /, "")
    .trim();
  const isUat = !!bearer && isUserActorToken(bearer);

  const userAuth = isUat
    ? await rbac.authenticateUserActor(request, { organizationId })
    : await rbac.authenticatePat(request, { organizationId });
  if (!userAuth.ok) {
    return json({ error: userAuth.error }, { status: userAuth.status });
  }

  if (!userAuth.ability.can(action, { type: resource })) {
    return json(
      {
        error: `You don't have permission to ${action} this organization's ${RESOURCE_LABELS[resource]}.`,
      },
      { status: 403 }
    );
  }

  return undefined;
}
