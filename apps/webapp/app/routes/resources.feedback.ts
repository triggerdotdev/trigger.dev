import { parse } from "@conform-to/zod";
import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { PlainClient, uiComponent } from "@team-plain/typescript-sdk";
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
  enterprise: "Enterprise enquiry",
  feedback: "General feedback",
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
  message: z.string().min(1, "Must be at least 1 character"),
});

export async function action({ request }: ActionFunctionArgs) {
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
        // TODO - Optional: set 'first name' on user
        // shortName: ''
        email: {
          email: user.email,
          isVerified: true,
        },
      },
      onUpdate: {
        externalId: { value: user.id },
        fullName: { value: user.name ?? "" },
        // TODO - see above
        // shortName: { value: "" },
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

    const title = feedbackTypeLabel[submission.value.feedbackType as FeedbackType];
    const createThreadRes = await client.createThread({
      customerIdentifier: {
        customerId: upsertCustomerRes.data.customer.id,
      },
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
      // TODO: Optional: set labels on threads here on creation
      // labelTypeIds: [],

      // TODO: Optional: set the priority (0 is urgent, 3 is low)
      // priority: 0,
    });

    if (createThreadRes.error) {
      console.error(
        inspect(createThreadRes.error, {
          showHidden: false,
          depth: null,
          colors: true,
        })
      );
      submission.error.message = createThreadRes.error.message;
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
