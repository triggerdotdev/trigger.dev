import { DynamicSchedule, DynamicTrigger, TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { createExpressServer } from "@trigger.dev/express";
import { z } from "zod";
import { Github, events } from "@trigger.dev/github";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

const github = new Github({
  id: "github-api-key",
  token: process.env["GITHUB_API_KEY"]!,
});

const dynamicOnIssueOpenedTrigger = new DynamicTrigger(client, {
  id: "github-issue-opened",
  event: events.onIssueOpened,
  source: github.sources.repo,
});

const dynamicUserTrigger = new DynamicTrigger(client, {
  id: "dynamic-user-trigger",
  event: events.onIssueOpened,
  source: github.sources.repo,
});

client.defineJob({
  id: "register-dynamic-trigger-on-new-repo",
  name: "Register dynamic trigger on new repo",
  version: "0.1.1",
  trigger: eventTrigger({
    name: "new.repo",
    schema: z.object({ owner: z.string(), repo: z.string() }),
  }),
  run: async (payload, io, ctx) => {
    return await io.registerTrigger("register-repo", dynamicOnIssueOpenedTrigger, payload.repo, {
      owner: payload.owner,
      repo: payload.repo,
    });
  },
});

client.defineJob({
  id: "listen-for-dynamic-trigger",
  name: "Listen for dynamic trigger",
  version: "0.1.1",
  trigger: dynamicOnIssueOpenedTrigger,

  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "listen-for-dynamic-trigger-2",
  name: "Listen for dynamic trigger-2",
  version: "0.1.1",
  trigger: dynamicOnIssueOpenedTrigger,

  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "listen-for-dynamic-trigger-3",
  name: "Listen for dynamic trigger-3",
  version: "0.1.1",
  trigger: dynamicOnIssueOpenedTrigger,
  run: async (payload, io, ctx) => {},
});

client.defineJob({
  id: "user-on-issue-opened",
  name: "user on issue opened",
  version: "0.1.1",
  trigger: dynamicUserTrigger,

  run: async (payload, io, ctx) => {
    await io.logger.info("user-on-issue-opened", { ctx });
  },
});

createExpressServer(client);
