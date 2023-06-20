import { parse } from "@conform-to/zod";
import { ActionArgs, json } from "@remix-run/server-runtime";
import { PlainClient } from "@team-plain/typescript-sdk";
import { z } from "zod";
import { env } from "~/env.server";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { CreateEndpointError } from "~/services/endpoints/createEndpoint.server";
import { requireUserId } from "~/services/session.server";

let client: PlainClient | undefined;

const feedbackType = z.union([z.literal("bug"), z.literal("feature")], {
  required_error: "Must be either 'bug' or 'feature'",
  invalid_type_error: "Must be either 'bug' or 'feature'",
});

export const schema = z.object({
  redirectPath: z.string(),
  feedbackType,
  message: z.string().min(1, "Must be at least 1 character"),
});

export async function action({ request }: ActionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();
  const submission = parse(formData, { schema });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  try {
    if (env.PLAIN_API_KEY) {
      client = new PlainClient({
        apiKey: env.PLAIN_API_KEY,
      });
    }

    return redirectWithSuccessMessage(
      submission.value.redirectPath,
      request,
      "Feedback submitted"
    );
  } catch (e) {
    return json(e, { status: 400 });
  }
}
