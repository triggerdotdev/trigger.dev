export function scheduledCron(apiKey: string) {
  return `import { Trigger, scheduleEvent } from "@trigger.dev/sdk";

new Trigger({
  //todo: ensure this id is only used for this workflow
  id: "cron-scheduled-workflow",
  name: "Cron Scheduled Workflow",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  //todo set your CRON expression here
  //this example runs every Monday at 2:30pm UTC
  //this site is useful when writing CRON: https://crontab.guru
  //you don't have to wait to test, use our "Test" button on your workflow page
  on: scheduleEvent({ cron: "30 14 * * 1" }),
  run: async (event, ctx) => {
    //this function is run every Monday at 2:30pm UTC
    await ctx.logger.info("Received the cron scheduled event", {
      event,
      wallTime: new Date(),
    });

    return { foo: "bar" };
  },
}).listen();`;
}
