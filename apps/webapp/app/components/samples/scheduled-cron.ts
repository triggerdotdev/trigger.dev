export function scheduledCron(apiKey: string) {
return `import { Trigger, scheduleEvent } from "@trigger.dev/sdk";

new Trigger({
  id: "cron-scheduled-workflow",
  name: "Cron Scheduled Workflow",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  on: scheduleEvent({ cron: "30 14 * * 1" }),
  run: async (event, ctx) => {
    await ctx.logger.info("Received the cron scheduled event", {
      event,
      wallTime: new Date(),
    });

    return { foo: "bar" };
  },
}).listen();`;
}