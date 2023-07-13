import { parse } from "@conform-to/zod";
import { ActionArgs, json } from "@remix-run/server-runtime";
import {
  ComponentDividerSpacingSize,
  ComponentSpacerSize,
  ComponentTextColor,
  ComponentTextSize,
  PlainClient,
} from "@team-plain/typescript-sdk";
import { inspect } from "util";
import { z } from "zod";
import { env } from "~/env.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";

let client: PlainClient | undefined;

export const feedbackTypeLabel = {
  bug: "Bug report",
  feature: "Feature request",
  help: "Help me out",
  integration: "Request an Integration",
};

export type FeedbackType = keyof typeof feedbackTypeLabel;

const feedbackTypeLiterals = Object.keys(feedbackTypeLabel).map((key) =>
  z.literal(key)
);

const feedbackType = z.union(
  [
    feedbackTypeLiterals[0],
    feedbackTypeLiterals[1],
    ...feedbackTypeLiterals.slice(2),
  ],
  {
    required_error: "Must be either 'bug' or 'feature'",
    invalid_type_error: "Must be either 'bug' or 'feature'",
  }
);

export const schema = z.object({
  path: z.string(),
  feedbackType,
  message: z.string().min(1, "Must be at least 1 character"),
});

export async function action({ request }: ActionArgs) {
  const user = await requireUser(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    if (!env.PLAIN_API_KEY) {
      console.error("PLAIN_API_KEY is not set");
      submission.error.message = "PLAIN_API_KEY is not set";
      return json(submission);
    }

    client = new PlainClient({
      apiKey: env.PLAIN_API_KEY,
    });

    const upsertCustomerRes = await client.upsertCustomer({
      identifier: {
        emailAddress: user.email,
      },
      onCreate: {
        externalId: user.id,
        fullName: user.name ?? "",
        email: {
          email: user.email,
          isVerified: true,
        },
      },
      onUpdate: {
        externalId: { value: user.id },
        fullName: { value: user.name ?? "" },
        email: {
          email: user.email,
          isVerified: true,
        },
      },
    });

    if (upsertCustomerRes.error) {
      console.error(
        inspect(upsertCustomerRes.error, {
          showHidden: false,
          depth: null,
          colors: true,
        })
      );
      submission.error.message = upsertCustomerRes.error.message;
      return json(submission);
    }

    const title =
      feedbackTypeLabel[submission.value.feedbackType as FeedbackType];
    const upsertTimelineEntryRes = await client.upsertCustomTimelineEntry({
      customerId: upsertCustomerRes.data.customer.id,
      title,
      components: [
        {
          componentText: {
            text: `New ${title} reported by ${user.name} (${user.email})`,
          },
        },
        {
          componentDivider: {
            dividerSpacingSize: ComponentDividerSpacingSize.M,
          },
        },
        {
          componentText: {
            textSize: ComponentTextSize.S,
            textColor: ComponentTextColor.Muted,
            text: "Page",
          },
        },
        {
          componentText: {
            text: submission.value.path,
          },
        },
        {
          componentSpacer: {
            spacerSize: ComponentSpacerSize.M,
          },
        },
        {
          componentText: {
            textSize: ComponentTextSize.S,
            textColor: ComponentTextColor.Muted,
            text: "Message",
          },
        },
        {
          componentText: {
            text: submission.value.message,
          },
        },
      ],
      changeCustomerStatusToActive: true,
      sendCustomTimelineEntryCreatedNotification: true,
    });

    if (upsertTimelineEntryRes.error) {
      console.error(
        inspect(upsertTimelineEntryRes.error, {
          showHidden: false,
          depth: null,
          colors: true,
        })
      );
      submission.error.message = upsertTimelineEntryRes.error.message;
      return json(submission);
    }

    return redirectWithSuccessMessage(
      submission.value.path,
      request,
      "Thanks for your feedback! We'll get back to you soon."
    );
  } catch (e) {
    return json(e, { status: 400 });
  }
}
