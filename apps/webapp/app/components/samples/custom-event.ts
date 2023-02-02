export const customEvent = `import { customEvent, Trigger } from "@trigger.dev/sdk";

new Trigger({
  id: "user-created-notify-slack",
  name: "User Created - Notify Slack",
  on: customEvent({
    name: "user.created",
    schema: z.object({ id: z.string(), admin: z.boolean() }),
    filter: {
      admin: [false],
    },
  }),
  run: async (event, ctx) => {},
}).listen();`;
