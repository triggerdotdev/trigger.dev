import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "@/trigger";
import task1 from "@/tasks/task1.background";

// Your first job
// This Job will be triggered by an event, log a joke to the console, and then wait 5 seconds before logging the punchline
client.defineJob({
  // This is the unique identifier for your Job, it must be unique across all Jobs in your project
  id: "example-job",
  name: "Background Task Usage",
  version: "0.0.1",
  // This is triggered by an event using eventTrigger. You can also trigger Jobs with webhooks, on schedules, and more: https://trigger.dev/docs/documentation/concepts/triggers/introduction
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    const output = await task1.invoke("task-1", {
      userName: "ericallam",
    });

    return { output };
  },
});
