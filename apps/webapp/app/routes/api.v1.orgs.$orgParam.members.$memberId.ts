import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { removeTeamMember } from "~/models/removeTeamMember.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ssoController } from "~/services/sso.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
  memberId: z.string(),
});

export const action = createActionPATApiRoute(
  {
    method: "DELETE",
    params: ParamsSchema,
    // Resolve the org (id only, no membership) so the plugin can compute the
    // caller's role floor for the manage:members gate below.
    context: async ({ orgParam }) => {
      const org = await prisma.organization.findFirst({
        where: { OR: [{ id: orgParam }, { slug: orgParam }], deletedAt: null },
        select: { id: true },
      });
      return org ? { organizationId: org.id } : {};
    },
    authorization: { action: "manage", resource: () => ({ type: "members" }) },
  },
  async ({ params, authentication }) => {
    // Membership floor: a non-member gets a 404.
    const organization = await resolveOrganizationForApiUser({
      orgParam: params.orgParam,
      userId: authentication.userId,
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    // Directory-managed membership: manual removal is disabled (mirrors the
    // dashboard Team page). Fail-open on a plugin error.
    const policy = await ssoController.getMembershipPolicy(organization.id);
    if (policy.isOk() && !policy.value.manualMembershipAllowed) {
      return json({ error: "Membership is managed by Directory Sync" }, { status: 403 });
    }

    // Org-scoped, TOCTOU-safe delete shared with the dashboard Team page. The
    // model throws ServiceValidationError (member-not-found 404, last-member
    // guard 400), which the builder maps to the response status.
    const removed = await removeTeamMember(
      {
        userId: authentication.userId,
        slug: organization.slug,
        memberId: params.memberId,
      },
      prisma
    );

    // Sticky removal: record a tombstone so passive SSO-JIT won't re-add them
    // (best-effort; no-op without the SSO plugin).
    await ssoController
      .recordMembershipRemoval({
        organizationId: organization.id,
        userId: removed.userId,
        reason: "manual_removal",
      })
      .unwrapOr(undefined);

    return json({
      id: removed.id,
      user: {
        id: removed.user.id,
        name: removed.user.name,
        email: removed.user.email,
      },
    });
  }
);
