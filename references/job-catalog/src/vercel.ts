import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient } from "@trigger.dev/sdk";
import { Vercel } from "@trigger.dev/vercel";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const vercel = new Vercel({
  id: "vercel",
  apiKey: process.env["VERCEL_API_KEY"]!,
});

client.defineJob({
  id: "vercel-deployment-created",
  name: "Vercel Deployment Created",
  version: "0.1.0",
  trigger: vercel.onDeploymentCreated({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("deployment created event received");
    io.logger.info(JSON.stringify(payload));
  },
});

createExpressServer(client);
