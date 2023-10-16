import { TriggerClient } from "npm:@trigger.dev/sdk";
import { eventTrigger } from "npm:@trigger.dev/sdk";

export const triggerClient = new TriggerClient({
  id: "borderless",
  apiKey: "...",
});

// your first job
triggerClient.defineJob({
  id: "example-job",
  name: "Example Job",
  version: "0.0.1",
  trigger: eventTrigger({
    name: "example.event",
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello world!", { payload });

    return {
      message: "Hello world!",
    };
  },
});

Deno.serve(async (req) => {
  const response = await triggerClient.handleRequest(req);
  if (!response) {
    return Response.json(
      { error: "Not found" },
      {
        status: 404,
      }
    );
  }

  return Response.json(response.body, {
    status: response.status,
    headers: response.headers,
  });
});
