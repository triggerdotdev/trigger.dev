import { task } from "@trigger.dev/sdk/v3";
import { ExampleEmail } from "./emails";
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
