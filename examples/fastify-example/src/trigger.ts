import { TriggerClient } from "@trigger.dev/sdk";
import { eventTrigger } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "fastify-example",
  apiKey: process.env.TRIGGER_API_KEY!,
  apiUrl: process.env.TRIGGER_API_URL!,
  logLevel: "debug",
  ioLogLocalEnabled: true,
  verbose: true,
});

client.defineJob({
  id: "fastify-example",
  name: "Fastify example",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "Fastify Test Run",
  }),
  run: async (_payload, io, _ctx) => {
    await io.wait("wait", 15);
    await io.logger.info("Hello Fastify!");
    return {
      message: "Trigger x Fastify",
    };
  },
});
