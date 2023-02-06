export function customEvent(apiKey: string) {
  return `import { customEvent, Trigger } from "@trigger.dev/sdk";
import { z } from "zod";

new Trigger({
  id: "user-created-notify-slack",
  name: "User Created - Notify Slack",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  on: customEvent({
    name: "user.created",
    schema: z.object({ id: z.string(), admin: z.boolean() }),
    filter: {
      admin: [false],
    },
  }),
  run: async (event, ctx) => {},
}).listen();`;
}
