import { parseWithZod } from "~/utils/conform";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { revokeInvite } from "~/models/member.server";
import { redirectWithErrorMessage, redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { dashboardAction } from "~/services/routeBuilders/dashboardBuilder";
import { organizationTeamPath } from "~/utils/pathBuilder";

export const revokeSchema = z.object({
  inviteId: z.string(),
  slug: z.string(),
});

export const action = dashboardAction(
  {
    // No URL params — resolve the org for the auth scope from the `slug`
    // in the form body. Read it off a clone so the handler can still parse
    // the original request.
    context: async (_params, request) => {
      const form = await request.clone().formData();
      const slug = form.get("slug");
      if (typeof slug !== "string") return {};
      const org = await $replica.organization.findFirst({
        where: { slug },
        select: { id: true },
      });
      return org ? { organizationId: org.id } : {};
    },
    authorization: { action: "write", resource: { type: "members" } },
  },
  async ({ request, user }) => {
    const formData = await request.formData();
    const submission = parseWithZod(formData, { schema: revokeSchema });

    if (submission.status !== "success") {
      return json(submission.reply());
    }

    try {
      const { email, organization } = await revokeInvite({
        userId: user.id,
        orgSlug: submission.value.slug,
        inviteId: submission.value.inviteId,
      });

      return redirectWithSuccessMessage(
        organizationTeamPath(organization),
        request,
        `Invite revoked for ${email}`
      );
    } catch (error) {
      // The Team page doesn't render this action's result, so the refusal goes back there as a toast.
      logger.warn("invite-revoke: couldn't revoke the invite", {
        inviteId: submission.value.inviteId,
        error: error instanceof Error ? error.message : String(error),
      });
      return redirectWithErrorMessage(
        organizationTeamPath({ slug: submission.value.slug }),
        request,
        "Couldn't revoke the invite. Please try again."
      );
    }
  }
);
