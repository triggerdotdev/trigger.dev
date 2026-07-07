import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { inviteMembers } from "~/models/member.server";
import { logger } from "~/services/logger.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";
import { acceptInvitePath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

const InviteRequestBody = z.object({
  emails: z.string().email().array().nonempty("At least one email is required"),
});

export const action = createActionPATApiRoute(
  {
    method: "POST",
    params: ParamsSchema,
    body: InviteRequestBody,
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
  async ({ params, body, authentication }) => {
    // Membership floor: a non-member gets a 404.
    const organization = await resolveOrganizationForApiUser({
      orgParam: params.orgParam,
      userId: authentication.userId,
    });

    if (!organization) {
      return json({ error: "Organization not found" }, { status: 404 });
    }

    const invites = await inviteMembers({
      slug: organization.slug,
      emails: body.emails,
      userId: authentication.userId,
    });

    // Send invite emails the same way the dashboard invite action does. A
    // failed send must not fail the invite (the row already exists); in local
    // dev with no SMTP config, scheduleEmail's transport logs instead.
    for (const invite of invites) {
      try {
        await scheduleEmail({
          email: "invite",
          to: invite.email,
          orgName: invite.organization.title,
          inviterName: invite.inviter.name ?? undefined,
          inviterEmail: invite.inviter.email,
          inviteLink: `${env.LOGIN_ORIGIN}${acceptInvitePath(invite.token)}`,
        });
      } catch (error) {
        logger.error("Failed to send invite email", { error });
      }
    }

    return json(
      {
        invites: invites.map((invite) => ({ id: invite.id, email: invite.email })),
      },
      { status: 201 }
    );
  }
);
