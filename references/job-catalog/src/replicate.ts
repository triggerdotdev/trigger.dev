import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { Replicate } from "@trigger.dev/replicate";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const replicate = new Replicate({
  id: "replicate",
  apiKey: process.env["REPLICATE_API_KEY"]!,
});

client.defineJob({
  id: "replicate-create-prediction",
  name: "Replicate - Create Prediction",
  version: "0.1.0",
  integrations: { replicate },
  trigger: eventTrigger({
    name: "replicate.predict",
    schema: z.object({
      prompt: z.string(),
      version: z.string(),
    }),
  }),
  run: async (payload, io, ctx) => {
    return io.replicate.predictions.createAndAwait("await-prediction", {
      version: payload.version,
      input: { prompt: payload.prompt },
    });
  },
});

createExpressServer(client);
