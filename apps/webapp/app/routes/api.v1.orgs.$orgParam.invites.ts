import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { inviteMembers } from "~/models/member.server";
import { checkInviteRateLimit, InviteRateLimitError } from "~/services/inviteRateLimiter.server";
import { logger } from "~/services/logger.server";
import { resolveOrganizationForApiUser } from "~/services/organizationApiAccess.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";
import { ssoController } from "~/services/sso.server";
import { acceptInvitePath } from "~/utils/pathBuilder";

const ParamsSchema = z.object({
  orgParam: z.string(),
});

const InviteRequestBody = z.object({
  emails: z
    .string()
    .email()
    .array()
    .nonempty("At least one email is required")
    .max(50, "At most 50 emails per request"),
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

    // Directory-managed membership: inviting is disabled (mirrors the dashboard
    // invite action). Fail-open on a plugin error.
    const policy = await ssoController.getMembershipPolicy(organization.id);
    if (policy.isOk() && !policy.value.manualMembershipAllowed) {
      return json({ error: "Membership is managed by Directory Sync" }, { status: 403 });
    }

    // Every invite emails the address, so cap per-org and per-inviter sends.
    if (env.LOGIN_RATE_LIMITS_ENABLED) {
      try {
        await checkInviteRateLimit(organization.id, authentication.userId, body.emails.length);
      } catch (error) {
        if (error instanceof InviteRateLimitError) {
          return json(
            { error: "Too many invites sent. Please try again later." },
            {
              status: 429,
              headers: {
                "Retry-After": Math.ceil(error.retryAfter / 1000).toString(),
              },
            }
          );
        }
        throw error;
      }
    }

    const { created, alreadyMembers, alreadyInvited } = await inviteMembers({
      slug: organization.slug,
      emails: body.emails,
      userId: authentication.userId,
    });

    // Email only the newly-created invites. A failed send must not fail the
    // request (the row exists); locally scheduleEmail's transport just logs.
    for (const invite of created) {
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

    // Report per-email outcome so callers aren't misled by an empty list on
    // re-invite. 201 when something was created, 200 when everything already
    // existed.
    return json(
      {
        invited: created.map((invite) => ({ id: invite.id, email: invite.email })),
        alreadyInvited,
        alreadyMembers,
      },
      { status: created.length > 0 ? 201 : 200 }
    );
  }
);
