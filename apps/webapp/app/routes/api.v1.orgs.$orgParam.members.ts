import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { getTeamMembersAndInvites } from "~/models/member.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

export const loader = createLoaderPATApiRoute(
  {
    params: ParamsSchema,
    // Resolve the org (id only, no membership) so the plugin can compute the
    // caller's role floor for the read:members gate below.
    context: async ({ orgParam }) => {
      const org = await prisma.organization.findFirst({
        where: { OR: [{ id: orgParam }, { slug: orgParam }], deletedAt: null },
        select: { id: true },
      });
      return org ? { organizationId: org.id } : {};
    },
    authorization: { action: "read", resource: () => ({ type: "members" }) },
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

    const result = await getTeamMembersAndInvites({
      userId: authentication.userId,
      organizationId: organization.id,
    });

    if (!result) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    return json({
      members: result.members.map((member) => ({
        id: member.id,
        role: member.role,
        user: {
          id: member.user.id,
          name: member.user.name,
          email: member.user.email,
          avatarUrl: member.user.avatarUrl,
        },
      })),
      invites: result.invites.map((invite) => ({
        id: invite.id,
        email: invite.email,
        updatedAt: invite.updatedAt,
        inviter: {
          id: invite.inviter.id,
          name: invite.inviter.name,
          email: invite.inviter.email,
        },
      })),
    });
  }
);
