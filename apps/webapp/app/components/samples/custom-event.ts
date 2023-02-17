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
    //todo define the schema for the events you want to receive
    //this example accepts JSON like this: { id: "123", admin: false }
    schema: z.object({ id: z.string(), admin: z.boolean() }),
    //todo define or remove the filter
    //filters are optional, but can be used to filter out events
    //this example stops the run function firing when data.admin === true
    filter: {
      admin: [false],
    },
  }),
  run: async (event, ctx) => {
    //insert your code here
  },
}).listen();`;
}
