import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { removeTeamMember } from "~/models/member.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

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

    // removeTeamMember enforces the last-member guard and throws
    // ServiceValidationError (member-not-found / last-member), which the
    // builder maps to its status.
    const removed = await removeTeamMember({
      userId: authentication.userId,
      slug: organization.slug,
      memberId: params.memberId,
    });

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
