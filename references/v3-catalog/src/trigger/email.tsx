import { logger, task } from "@trigger.dev/sdk/v3";
import { ExampleEmail } from "./emails/index.js";
import { render } from "@react-email/render";

export const emailTask = task({
  id: "email",
  run: async () => {
    return {
      subject: "Example email",
      react: render(<ExampleEmail />),
    };
  },
});
