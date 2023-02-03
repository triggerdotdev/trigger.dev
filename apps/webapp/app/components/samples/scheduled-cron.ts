export function scheduledCron(apiKey: string) {
return `import { Trigger, scheduleEvent } from "@trigger.dev/sdk";

new Trigger({
  id: "cron-scheduled-workflow",
  name: "Cron Scheduled Workflow",
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