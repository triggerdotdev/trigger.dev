import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { revokeInvite } from "~/models/member.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
  inviteId: z.string(),
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

    try {
      const revoked = await revokeInvite({
        userId: authentication.userId,
        orgSlug: organization.slug,
        inviteId: params.inviteId,
      });

      return json({ id: params.inviteId, email: revoked.email });
    } catch (error) {
      if (error instanceof Error && error.message === "Invite not found") {
        return json({ error: error.message }, { status: 404 });
      }
      throw error;
    }
  }
);
