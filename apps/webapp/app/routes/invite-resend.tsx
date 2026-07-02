import { parseWithZod } from "@conform-to/zod";
import { json } from "@remix-run/server-runtime";
import { env } from "process";
import { z } from "zod";
import { $replica } from "~/db.server";
import { resendInvite } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { scheduleEmail } from "~/services/scheduleEmail.server";
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
  async ({ request, user }) => {
    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: resendSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
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
