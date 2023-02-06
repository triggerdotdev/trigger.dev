export function scheduled() {
  return `import { Trigger, scheduleEvent } from "@trigger.dev/sdk";

new Trigger({
  id: "scheduled-workflow",
  name: "Scheduled Workflow",
  apiKey: "<your_api_key>",
  on: scheduleEvent({ rateOf: { minutes: 5 } }),
  run: async (event, ctx) => {
    await ctx.logger.info("Received the scheduled event", {
      event,
      wallTime: new Date(),
    });

    return { foo: "bar" };
  },
}).listen();`;
}
