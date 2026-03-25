import { parse } from "@conform-to/zod";
import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { type PlainClient, uiComponent } from "@team-plain/typescript-sdk";
import { z } from "zod";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";
import { sendToPlain } from "~/utils/plain.server";

let client: PlainClient | undefined;

export const feedbackTypeLabel = {
  bug: "Bug report",
  feature: "Feature request",
  help: "Help me out",
  enterprise: "Enterprise enquiry",
  feedback: "General feedback",
  concurrency: "Increase my concurrency",
  region: "Suggest a new region",
};

export type FeedbackType = keyof typeof feedbackTypeLabel;

const feedbackTypeLiterals = Object.keys(feedbackTypeLabel).map((key) => z.literal(key));

const feedbackType = z.union(
  [feedbackTypeLiterals[0], feedbackTypeLiterals[1], ...feedbackTypeLiterals.slice(2)],
  {
    required_error: "Must be either 'bug' or 'feature'",
    invalid_type_error: "Must be either 'bug' or 'feature'",
  }
);

export const schema = z.object({
  path: z.string(),
  feedbackType,
  message: z.string().min(10, "Must be at least 10 characters"),
});

export async function action({ request }: ActionFunctionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  const title = feedbackTypeLabel[submission.value.feedbackType as FeedbackType];
  try {
    await sendToPlain({
      userId: user.id,
      email: user.email,
      name: user.name ?? user.displayName ?? user.email,
      title,
      components: [
        uiComponent.text({
          text: `New ${title} reported by ${user.name} (${user.email})`,
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
      submission.value.path,
      request,
      "Thanks for your feedback! We'll get back to you soon."
    );
  } catch (e) {
    submission.error.message = [e instanceof Error ? e.message : "Unknown error"];
    return json(submission);
  }
}
