import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "~/trigger";

// your first job
client.defineJob({
  id: "remix-test-job",
  name: "remix test job",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "remix.test",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello world!", { payload });

    return {
      message: "Hello world!",
    };
  },
});
