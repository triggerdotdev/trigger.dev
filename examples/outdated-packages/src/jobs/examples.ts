
import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "@/trigger";

// Your first job
// This Job will be triggered by an event, log a joke to the console, and then wait 5 seconds before logging the punchline
client.defineJob({
  // This is the unique identifier for your Job, it must be unique across all Jobs in your project
  id: "example-job",
  name: "Example Job: a joke with a delay",
  version: "0.0.1",
  // This is triggered by an event using eventTrigger. You can also trigger Jobs with webhooks, on schedules, and more: https://trigger.dev/docs/documentation/concepts/triggers/introduction
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    // This logs a message to the console
    await io.logger.info("🧪 Example Job: a joke with a delay");
    await io.logger.info("How do you comfort a JavaScript bug?");
    // This waits for 5 seconds, the second parameter is the number of seconds to wait, you can add delays of up to a year
    await io.wait("Wait 5 seconds for the punchline...", 5);
    await io.logger.info("You console it! 🤦");
    await io.logger.info(
      "✨ Congratulations, You just ran your first successful Trigger.dev Job! ✨"
    );
    // To learn how to write much more complex (and probably funnier) Jobs, check out our docs: https://trigger.dev/docs/documentation/guides/create-a-job
  },
});

