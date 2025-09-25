import { parse } from "@conform-to/zod";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { env } from "process";
import { z } from "zod";
import { resendInvite } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { scheduleEmail } from "~/services/email.server";
import { requireUserId } from "~/services/session.server";
import { acceptInvitePath, organizationTeamPath } from "~/utils/pathBuilder";

export const resendSchema = z.object({
  inviteId: z.string(),
});

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema: resendSchema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const invite = await resendInvite({
      inviteId: submission.value.inviteId,
      userId,
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
};
