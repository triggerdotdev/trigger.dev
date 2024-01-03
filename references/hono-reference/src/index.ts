import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createMiddleware } from "@trigger.dev/hono";
import { TriggerClient, invokeTrigger } from "@trigger.dev/sdk";

const client = new TriggerClient({
  id: "hono-client",
  apiKey: process.env.TRIGGER_API_KEY!,
  apiUrl: process.env.TRIGGER_API_URL!,
});

client.defineJob({
  id: "hono-job",
  name: "Hono Job",
  version: "1.0.0",
  trigger: invokeTrigger(),
  run: async (payload, io, ctx) => {
    await io.logger.info("Hello Hono!", { ctx });

    await io.wait("1s", 1);

    await io.runTask("hono-task", async () => {
      return {
        status: "success",
        output: "Hello Hono!",
      };
    });
  },
});

const app = new Hono();

app.use("/api/trigger", createMiddleware(client));

app.get("/", (c) => c.text("Hello Hono!"));

serve(app, (info) => {
  console.log(`Listening on port ${info.port}`);
});
