import { parseWithZod } from "~/utils/conform";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { resendInvite } from "~/models/member.server";
import { env } from "~/env.server";
import { publicAppOrigin } from "~/services/adminOrigin.server";
import { checkInviteRateLimit, InviteRateLimitError } from "~/services/inviteRateLimiter.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";
import { ssoController } from "~/services/sso.server";
import { canInviteWithRole } from "~/services/inviteRole.server";
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
        select: {
          organizationId: true,
          rbacRoleId: true,
          role: true,
          organization: { select: { slug: true } },
        },
      });
      return invite ? { organizationId: invite.organizationId, invite } : {};
    },
    authorization: { action: "write", resource: { type: "members" } },
  },
  async ({ request, user, context }) => {
    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: resendSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    // The Team page doesn't render this action's result, so a refusal goes back there as a toast.
    const refuse = (message: string, status: number) =>
      context.invite
        ? redirectWithErrorMessage(
            organizationTeamPath(context.invite.organization),
            request,
            message
          )
        : json({ errors: { body: message } }, { status });

    // Resending is an "add" — blocked when membership is directory-managed.
    if (context.organizationId) {
      const policy = await ssoController.getMembershipPolicy(context.organizationId);
      if (policy.isOk() && !policy.value.manualMembershipAllowed) {
        return refuse("Membership is managed by Directory Sync", 403);
      }
    }

    // The role must still be at or below the resender's, who may have been demoted since sending.
    if (
      context.invite &&
      !(await canInviteWithRole({
        userId: user.id,
        organizationId: context.invite.organizationId,
        rbacRoleId: context.invite.rbacRoleId,
        legacyRole: context.invite.role,
      }))
    ) {
      return refuse("You can only resend invites at or below your own role", 403);
    }

    // Every resend emails the invitee, so apply the same per-org /
    // per-inviter cap as the invite-create API. With no org scope (the
    // inviteId lookup above found nothing), resendInvite rejects anyway.
    if (env.LOGIN_RATE_LIMITS_ENABLED && context.organizationId) {
      try {
        await checkInviteRateLimit(context.organizationId, user.id, 1);
      } catch (error) {
        if (error instanceof InviteRateLimitError) {
          return refuse("Too many invites sent. Please try again later.", 429);
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
          inviteLink: `${publicAppOrigin()}${acceptInvitePath(invite.token)}`,
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
    } catch (error) {
      logger.warn("invite-resend: couldn't resend the invite", {
        inviteId: submission.value.inviteId,
        error: error instanceof Error ? error.message : String(error),
      });
      return refuse("Couldn't resend the invite. Please try again.", 400);
    }
  }
);
