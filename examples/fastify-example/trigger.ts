import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "fastify-example",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
});

// your first job
client.defineJob({
  id: "fastify-example",
  name: "fastify example Job",
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