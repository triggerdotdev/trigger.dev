import { parse } from "@conform-to/zod";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { revokeInvite } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUserId } from "~/services/session.server";
import { organizationTeamPath } from "~/utils/pathBuilder";

export const revokeSchema = z.object({
  inviteId: z.string(),
  slug: z.string(),
});

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema: revokeSchema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    const { email, organization } = await revokeInvite({
      userId,
      orgSlug: submission.value.slug,
      inviteId: submission.value.inviteId,
    });

    return redirectWithSuccessMessage(
      organizationTeamPath(organization),
      request,
      `Invite revoked for ${email}`
    );
  } catch (error: any) {
    return json({ errors: { body: error.message } }, { status: 400 });
  }
};
