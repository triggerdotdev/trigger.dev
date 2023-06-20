import { parse } from "@conform-to/zod";
import { ActionArgs, json } from "@remix-run/server-runtime";
import { PlainClient } from "@team-plain/typescript-sdk";
import { inspect } from "util";
import { s } from "vitest/dist/index-6e18a03a";
import { z } from "zod";
import { env } from "~/env.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { requireUser } from "~/services/session.server";

let client: PlainClient | undefined;

const feedbackType = z.union(
  [z.literal("bug"), z.literal("feature"), z.literal("help")],
  {
    required_error: "Must be either 'bug' or 'feature'",
    invalid_type_error: "Must be either 'bug' or 'feature'",
  }
);

const feedbackTypeLabel = {
  bug: "Bug",
  feature: "Feature request",
  help: "Help",
};

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
        fullName: user.name ?? "",
        email: {
          email: user.email,
          isVerified: true,
        },
      },
      onUpdate: {},
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

    const upsertTimelineEntryRes = await client.upsertCustomTimelineEntry({
      customerId: upsertCustomerRes.data.customer.id,
      title: feedbackTypeLabel[submission.value.feedbackType],
      components: [
        {
          componentText: {
            text: submission.value.message,
          },
        },
      ],
      changeCustomerStatusToActive: true,
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
      "Feedback submitted"
    );
  } catch (e) {
    return json(e, { status: 400 });
  }
}
