export function scheduled(apiKey: string) {
  return `import { Trigger, scheduleEvent } from "@trigger.dev/sdk";

new Trigger({
  //todo: ensure this id is only used for this workflow
  id: "scheduled-workflow",
  name: "Scheduled Workflow",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  //todo set how often you want your event to fire here
  //this example runs every 5 minutes, the first run will be 5 minutes after the workflow is first connected
  //you don't have to wait to test, use our "Test" button on your workflow page
  on: scheduleEvent({ rateOf: { minutes: 5 } }),
  run: async (event, ctx) => {
    //this function is run every 5 minutes
    await ctx.logger.info("Received the scheduled event", {
      event,
      wallTime: new Date(),
    });

    return { foo: "bar" };
  },
}).listen();`;
}
