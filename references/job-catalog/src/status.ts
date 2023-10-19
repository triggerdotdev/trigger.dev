import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "status",
  name: "Status: updating status",
  version: "0.0.2",
  trigger: eventTrigger({
    name: "status",
  }),
  run: async (payload, io, ctx) => {
    const generatingText = await io.createStatus("generating-images", {
      label: "Generating Images",
      state: "loading",
      data: {
        progress: 0.1,
      },
    });

    await io.wait("wait", 2);

    //...do stuff
    await generatingText.update("middle-generation", {
      data: {
        progress: 0.5,
        urls: ["http://www."],
      },
    });

    await io.wait("wait-again", 2);

    //...do stuff
    await generatingText.update("completed-generation", {
      label: "Generated images",
      state: "success",
      data: {
        progress: 1.0,
        urls: ["http://www.", "http://www.", "http://www."],
      },
    });

    await io.runTask("get statuses", async () => {
      return await client.getRunStatuses(ctx.run.id);
    });

    await io.runTask("get run", async () => {
      return await client.getRun(ctx.run.id);
    });
  },
});

createExpressServer(client);
