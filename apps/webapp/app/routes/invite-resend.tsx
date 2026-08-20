import { parseWithZod } from "@conform-to/zod";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { resendInvite } from "~/models/member.server";
import { env } from "~/env.server";
import { checkInviteRateLimit, InviteRateLimitError } from "~/services/inviteRateLimiter.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";
import { ssoController } from "~/services/sso.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { acceptInvitePath, organizationTeamPath } from "~/utils/pathBuilder";

export const resendSchema = z.object({
  inviteId: z.string(),
});

export const action = dashboardAction(
  {
    // No URL params — resolve the org for the auth scope from the invite
    // referenced in the form body. Read it off a clone so the handler can
    // still parse the original request.
    context: async (_params, request) => {
      const form = await request.clone().formData();
      const inviteId = form.get("inviteId");
      if (typeof inviteId !== "string") return {};
      const invite = await $replica.orgMemberInvite.findFirst({
        where: { id: inviteId },
        select: { organizationId: true },
      });
      return invite ? { organizationId: invite.organizationId } : {};
    },
    authorization: { action: "manage", resource: { type: "members" } },
  },
  async ({ request, user, context }) => {
    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: resendSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    // Resending is an "add" — blocked when membership is directory-managed.
    if (context.organizationId) {
      const policy = await ssoController.getMembershipPolicy(context.organizationId);
      if (policy.isOk() && !policy.value.manualMembershipAllowed) {
        return json(
          { errors: { body: "Membership is managed by Directory Sync" } },
          { status: 403 }
        );
      }
    }

    // Every resend emails the invitee, so apply the same per-org /
    // per-inviter cap as the invite-create API. With no org scope (the
    // inviteId lookup above found nothing), resendInvite rejects anyway.
    if (env.LOGIN_RATE_LIMITS_ENABLED && context.organizationId) {
      try {
        await checkInviteRateLimit(context.organizationId, user.id, 1);
      } catch (error) {
        if (error instanceof InviteRateLimitError) {
          return json(
            { errors: { body: "Too many invites sent. Please try again later." } },
            { status: 429 }
          );
        }
        throw error;
      }
    }

    try {
      const invite = await resendInvite({
        inviteId: submission.value.inviteId,
        userId: user.id,
      });

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
        console.error("Failed to send invite email");
        console.error(error);
        throw new Error("Failed to send invite email");
      }

      return redirectWithSuccessMessage(
        organizationTeamPath(invite.organization),
        request,
        `Invite resent to ${invite.email}`
      );
    } catch (error: any) {
      return json({ errors: { body: error.message } }, { status: 400 });
    }
  }
);
