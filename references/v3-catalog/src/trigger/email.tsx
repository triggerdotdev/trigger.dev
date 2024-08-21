import { logger, task } from "@trigger.dev/sdk/v3";
import { ExampleEmail } from "./emails/index.js";
import { render } from "@react-email/render";
import EmailReplyParser from "email-reply-parser";

export const emailTask = task({
  id: "email",
  run: async () => {
    return {
      subject: "Example email",
      react: render(<ExampleEmail />),
    };
  },
});

export const parseEmailReplyTask = task({
  id: "parse-email-reply",
  run: async ({ email }: { email: string }) => {
    const parsed = new EmailReplyParser().read(email);

    logger.log("Parsed email", {
      email,
      parsed,
    });
  },
});
