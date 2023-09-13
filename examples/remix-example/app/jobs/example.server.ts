import { eventTrigger } from "@trigger.dev/sdk";
import { client } from "~/trigger";

// your first job
export const job = client.defineJob({
  id: "remix-job-6",
  name: "remix-wait-job",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "remix.test",
  }),
  run: async (payload, io, ctx) => {
    await io.wait("waiting", 5);
    await io.logger.info("Hello world!", { payload });

    return {
      message: "Hello world!",
    };
  },
});
