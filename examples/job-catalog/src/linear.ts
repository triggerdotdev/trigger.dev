import { createExpressServer } from "@trigger.dev/express";
import { DynamicTrigger, TriggerClient } from "@trigger.dev/sdk";
import { Linear, events } from "@trigger.dev/linear";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const linear = new Linear({
  id: "linear-v2",
  token: process.env["LINEAR_API_KEY"],
});

const dynamicOnAttachmentTrigger = new DynamicTrigger(client, {
  id: "linear-attachment",
  event: events.onAttachment,
  source: linear.source,
});

client.defineJob({
  id: "linear-on-issue",
  name: "Linear On Issue",
  version: "0.1.0",
  trigger: linear.onIssue(),
  run: async (payload, io, ctx) => {
    await io.logger.info("Issue changed!", {
      action: payload.action,
      id: payload.data.id,
      url: payload.url,
    });
  },
});

client.defineJob({
  id: "linear-on-Comment",
  name: "Linear On Comment",
  version: "0.1.0",
  trigger: linear.onCommentCreate(),
  run: async (payload, io, ctx) => {
    await io.logger.info("Comment created!", {
      action: payload.action,
      id: payload.data.id,
      url: payload.url,
    });
  },
});

client.defineJob({
  id: "linear-on-Reaction",
  name: "Linear On Reaction",
  version: "0.1.0",
  trigger: linear.onReactionUpdate(),
  run: async (payload, io, ctx) => {
    await io.logger.info("Reaction updated!", {
      action: payload.action,
      id: payload.data.id,
      url: payload.url,
    });
  },
});

createExpressServer(client);
