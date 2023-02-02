export const newUserSlackMessage = `import { Trigger, customEvent } from "@trigger.dev/sdk";
import { postMessage } from "@trigger.dev/slack";
import { z } from "zod";

new Trigger({
  id: "new-user",
  name: "New user slack message",
  apiKey: "<your_api_key>",
  on: customEvent({
    name: "user.created",
    schema: z.object({
      name: z.string(),
      email: z.string(),
      paidPlan: z.boolean(),
    }),
  }),
  run: async (event, ctx) => {
    await ctx.logger.info("This log will appear on the Trigger.dev run page");

    //send a message to the #new-users Slack channel with user details
    const response = await postMessage("send-to-slack", {
      channel: "new-users",
      text: \`New user: \${event.name} (\${event.email}) signed up. \${
        event.paidPlan ? "They are paying" : "They are on the free plan"
      }.\`,
    });

    return response.message;
  },
}).listen();`;
