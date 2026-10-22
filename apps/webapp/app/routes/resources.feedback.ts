import { parseWithZod } from "@conform-to/zod/v4";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { uiComponent } from "@team-plain/ui-components";
import { $replica, prisma } from "~/db.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { logger } from "~/services/logger.server";
import { requireUser } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";
import { type FeedbackType, feedbackTypes, schema } from "~/utils/feedback";
import { feedbackOrganization } from "~/utils/feedbackOrganization.server";
import { sendToPlain } from "~/utils/plain.server";

export type { FeedbackType };

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const submission = parseWithZod(formData, { schema });

  if (submission.status !== "success") {
    return json(submission.reply());
  }

  const inquiry = feedbackTypes[submission.value.feedbackType as FeedbackType];
  const redirectPath = sanitizeRedirectPath(submission.value.path);
  try {
    // Best-effort: a failed lookup sends the message without an org rather than losing it.
    const organization = await feedbackOrganization(
      user.id,
      submission.value.path,
      $replica,
      prisma
    ).catch((error) => {
      logger.error("Failed to resolve feedback organization", { error });
      return undefined;
    });
    await sendToPlain({
      userId: user.id,
      email: user.email,
      name: user.name ?? user.displayName ?? user.email,
      title: inquiry.threadTitle,
      labelTypeIds: inquiry.labelTypeId ? [inquiry.labelTypeId] : undefined,
      organizationId: organization?.id,
      organizationName: organization?.title,
      components: [
        uiComponent.text({
          text: `New ${inquiry.label} reported by ${user.name} (${user.email})`,
        }),
        uiComponent.divider({ spacingSize: "M" }),
        uiComponent.text({
          size: "S",
          color: "MUTED",
          text: "Page",
        }),
        uiComponent.text({
          text: submission.value.path,
        }),
        uiComponent.spacer({ size: "M" }),
        uiComponent.text({
          size: "S",
          color: "MUTED",
          text: "Message",
        }),
        uiComponent.text({
          text: submission.value.message,
        }),
      ],
    });

    return redirectWithSuccessMessage(
      redirectPath,
      request,
      "Thanks for your feedback! We'll get back to you soon."
    );
  } catch (e) {
    return json(
      submission.reply({
        fieldErrors: { message: [e instanceof Error ? e.message : "Unknown error"] },
      })
    );
  }
}
