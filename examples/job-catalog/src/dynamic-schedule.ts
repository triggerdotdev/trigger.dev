import { DynamicSchedule, TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const dynamicSchedule = new DynamicSchedule(client, {
  id: "dynamic-interval",
});

client.defineJob({
  id: "get-user-repo-on-schedule",
  name: "Get User Repo On Schedule",
  version: "0.1.1",
  trigger: dynamicSchedule,

  run: async (payload, io, ctx) => {
    io.logger.log("Hello World");
  },
});

client.defineJob({
  id: "register-dynamic-interval",
  name: "Register Dynamic Interval",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "dynamic.interval",
    schema: z.object({
      id: z.string(),
      seconds: z.number().int().positive(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.registerInterval("📆", dynamicSchedule, payload.id, {
      seconds: payload.seconds,
    });

    await io.wait("wait", payload.seconds + 10);

    await io.unregisterInterval("❌📆", dynamicSchedule, payload.id);
  },
});

client.defineJob({
  id: "register-dynamic-cron",
  name: "Register Dynamic Cron",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "dynamic.cron",
    schema: z.object({
      id: z.string(),
      cron: z.string(),
    }),
  }),
  run: async (payload, io, ctx) => {
    await io.registerCron("📆", dynamicSchedule, payload.id, {
      cron: payload.cron,
    });

    await io.wait("wait", 60);

    await io.unregisterCron("❌📆", dynamicSchedule, payload.id);
  },
});

createExpressServer(client);
