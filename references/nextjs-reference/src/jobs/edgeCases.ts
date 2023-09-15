import { client } from "@/trigger";
import { Job, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

client.defineJob({
  id: "test-long-running-cpu",
  name: "Test long running CPU",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "test.cpu",
    schema: z.object({
      iterations: z.number(),
      sleepDuration: z.number(),
    }),
  }),
  run: async (payload, io, ctx) => {
    console.log(`Running run ${ctx.run.id} at ${new Date().toISOString()}`);

    for (let i = 0; i < payload.iterations ?? 1; i++) {
      await new Promise((resolve) => setTimeout(resolve, payload.sleepDuration ?? 1000));
    }

    console.log(`Finishing run ${ctx.run.id} at ${new Date().toISOString()}`);
  },
});
