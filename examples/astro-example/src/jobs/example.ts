import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "../trigger";

// your first job
  client.defineJob({
    id: "astro-test",
    name: "astro test Job",
    version: "0.0.1",
    trigger: eventTrigger({
      name: "test.event",
    }),
    run: async (payload, io, ctx) => {

      await io.wait("hold on ", 5);

      await io.logger.info("Hello world!", { payload });
      return {
        message: "Hello world!",
      };
    },
  });
