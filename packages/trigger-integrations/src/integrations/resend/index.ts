import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import { resend } from "@trigger.dev/providers";
import { render } from "@react-email/render";

export type SendEmailOptions = z.infer<
  typeof resend.schemas.SendEmailOptionsSchema
>;

export type SendEmailResponse = z.infer<
  typeof resend.schemas.SendEmailSuccessResponseSchema
>;

export async function sendEmail(
  key: string,
  message: SendEmailOptions
): Promise<SendEmailResponse> {
  const run = getTriggerRun();

  if (!run) {
    throw new Error("Cannot call sendEmail outside of a trigger run");
  }

  //if the supplied email body is react, we need to turn it into html
  let html: string | undefined = undefined;
  if (message.react) {
    html = render(message.react, {
      pretty: true,
    });
  } else if (message.html) {
    html = message.html;
  }

  const params = {
    ...message,
    html,
    react: undefined,
  };

  const output = await run.performRequest(key, {
    service: "resend",
    endpoint: "email.send",
    params,
    response: {
      schema: resend.schemas.SendEmailSuccessResponseSchema,
    },
  });

  return output;
}
