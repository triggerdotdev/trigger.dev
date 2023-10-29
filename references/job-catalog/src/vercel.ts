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
  id: "vercel-5",
  apiKey: process.env["VERCEL_API_KEY"]!,
});

client.defineJob({
  id: "vercel-deployment-created-proj",
  name: "Vercel Deployment Created (Project)",
  version: "0.1.0",
  trigger: vercel.onDeploymentCreated({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
    projectIds: ["prj_vt57HZEY7iilPaJv71LcOVLcEiMu"],
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("deployment created event received");
    io.logger.info(JSON.stringify(payload));
  },
});

client.defineJob({
  id: "vercel-deployment-created-team",
  name: "Vercel Deployment Created (Team)",
  version: "0.1.0",
  trigger: vercel.onDeploymentCreated({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("deployment created event received");
  },
});

client.defineJob({
  id: "vercel-deployment-succeeded",
  name: "Vercel Deployment Succeeded",
  version: "0.1.0",
  trigger: vercel.onDeploymentSucceeded({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("deployment succeeded event received");
  },
});

client.defineJob({
  id: "vercel-deployment-canceled",
  name: "Vercel Deployment Canceled",
  version: "0.1.0",
  trigger: vercel.onDeploymentCanceled({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("deployment canceled event received");
  },
});

client.defineJob({
  id: "vercel-deployment-error",
  name: "Vercel Deployment Error",
  version: "0.1.0",
  trigger: vercel.onDeploymentError({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("deployment error event received");
  },
});

client.defineJob({
  id: "vercel-project-created",
  name: "Vercel Project Created",
  version: "0.1.0",
  trigger: vercel.onProjectCreated({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("project created event received");
  },
});

client.defineJob({
  id: "vercel-project-removed",
  name: "Vercel Project Removed",
  version: "0.1.0",
  trigger: vercel.onProjectRemoved({
    teamId: "team_kTDbLdHFZ0x7HU66LRgZCfqg",
  }),
  run: async (payload, io, ctx) => {
    io.logger.info("project removed event received");
  },
});

createExpressServer(client);
