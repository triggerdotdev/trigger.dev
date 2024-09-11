import { task } from "@trigger.dev/sdk/v3";
import { renderExampleEmail } from "@repo/email";

export const reactEmail = task({
  id: "react-email",
  run: async () => {
    return await renderExampleEmail();
  },
});
