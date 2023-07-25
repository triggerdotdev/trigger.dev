import { client } from "@/trigger";
import { eventTrigger } from "@trigger.dev/sdk";

client.defineJob({
  id: "hooks-test-job",
  name: "Hooks test job",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "test-event",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.log("This Job is triggered from a button in the frontend");
    await io.wait("wait", 20);
    await io.logger.log("It runs for a while to test the React hooks");
    await io.wait("wait 2", 10);
    await io.logger.log("This is the end of the job");
  },
});
