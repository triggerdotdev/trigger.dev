import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, invokeTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.on("runSucceeeded", async (notification) => {
  console.log("[client] Run succeeded", notification);
});

client.on("runFailed", async (notification) => {
  console.log("[client] Run failed", notification);
});

client.defineJob({
  id: "notifications-tester",
  name: "Notifications Tester",
  version: "1.0.0",
  trigger: invokeTrigger({
    schema: z.object({
      forceTaskError: z.boolean().default(false),
    }),
  }),
  onFailure(notification) {
    console.log("[job] Job failed", notification);
  },
  onSuccess(notification) {
    console.log("[job] Job succeeded", notification);
  },
  run: async (payload, io, ctx) => {
    await io.wait("wait-1", 1);

    if (payload.forceTaskError) {
      await io.runTask("task-1", async () => {
        throw new Error("Task failed");
      });
    }
  },
});

createExpressServer(client);
