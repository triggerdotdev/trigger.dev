export function scheduled(apiKey: string) {
  return `import { Trigger, scheduleEvent } from "@trigger.dev/sdk";

new Trigger({
  id: "scheduled-workflow",
  name: "Scheduled Workflow",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
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
