import { getTriggerRun } from "@trigger.dev/sdk";
import { z } from "zod";
import { render } from "@react-email/render";
import {
  SendEmailOptionsSchema,
  SendEmailSuccessResponseSchema,
} from "./schemas";

export type SendEmailOptions = z.infer<typeof SendEmailOptionsSchema>;

export type SendEmailResponse = z.infer<typeof SendEmailSuccessResponseSchema>;

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

  let params: any;
  if (html) {
    params = {
      ...message,
      reply_to: message.replyTo,
      html,
    };
  } else {
    params = {
      ...message,
      reply_to: message.replyTo,
    };
    delete params.html;
  }
  delete params.replyTo;
  delete params.react;

  const output = await run.performRequest(key, {
    service: "resend",
    endpoint: "email.send",
    params,
    response: {
      schema: SendEmailSuccessResponseSchema,
    },
  });

  return output;
}
