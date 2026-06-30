import { parseWithZod } from "@conform-to/zod";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { revokeInvite } from "~/models/member.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
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
    authorization: { action: "manage", resource: { type: "members" } },
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
    } catch (error: any) {
      return json({ errors: { body: error.message } }, { status: 400 });
    }
  }
);
