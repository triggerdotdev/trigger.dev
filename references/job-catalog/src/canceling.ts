import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger, invokeTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const cancelThisJob = client.defineJob({
  id: "cancel-this-job",
  name: "Canceling: this job",
  version: "1.0.0",
  trigger: invokeTrigger({ schema: z.number() }),
  run: async (payload, io, ctx) => {
    await io.logger.info(`Hello World ${payload}`);
    await io.wait("wait", 30);
  },
});

client.defineJob({
  id: "canceling-starter",
  name: "Canceling: start",
  version: "1.0.0",
  enabled: true,
  trigger: eventTrigger({
    name: "event.example",
  }),
  run: async (payload, io, ctx) => {
    const data = Array.from({ length: 25 }, (_, i) => i);
    for (const i of data) {
      await cancelThisJob.invoke(`invoke-${i}`, i);
    }

    const result = await client.cancelRunsForJob(cancelThisJob.id);
    await io.logger.info(`Canceled ${result.cancelledRunIds.length} runs`, result);
  },
});

createExpressServer(client);
