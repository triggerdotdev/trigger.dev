import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "../trigger";

// use Open AI to summarize text from the form
client.defineJob({
  id: "react-hook",
  name: "React Hook test",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "react-hook",
  }),
  run: async (_payload, io) => {
    await io.wait("Wait 2 seconds", 2);
    await io.wait("Wait 1 second", 1);

    return {
      summary: "This is the output value from the Job",
    };
  },
});
