import { addMiddleware } from "@trigger.dev/hono";
import { TriggerClient, invokeTrigger } from "@trigger.dev/sdk";
import { Hono } from "hono";

type Bindings = {
  TRIGGER_API_KEY: string;
  TRIGGER_API_URL: string;
};

const app = new Hono<{ Bindings: Bindings }>();

addMiddleware(app, (env) => {
  const client = new TriggerClient({
    id: "wrangler-test",
    apiKey: env.TRIGGER_API_KEY,
    apiUrl: env.TRIGGER_API_URL,
  });

  client.defineJob({
    id: "wrangler-job",
    name: "Wrangler Job",
    version: "1.0.0",
    trigger: invokeTrigger(),
    run: async (payload, io, ctx) => {},
  });

  return client;
});

export default app;
