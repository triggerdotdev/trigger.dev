import { setupServer } from "msw/node";
import { handlers } from "./mocks/handlers";

const mockServer = setupServer(...handlers);
mockServer.listen({
  onUnhandledRequest: "bypass",
});

import { Github } from "@trigger.dev/github";
import { OpenAI } from "@trigger.dev/openai";
import { TriggerClient } from "@trigger.dev/sdk";
import { Slack } from "@trigger.dev/slack";

export const client = new TriggerClient({
  id: "nextjs-example",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
  verbose: false,
  ioLogLocalEnabled: true,
});

export const github = new Github({
  id: "github",
  octokitRequest: { fetch },
});

export const githubUser = new Github({
  id: "github-user",
  octokitRequest: { fetch },
});

// const githubLocal = new Github({
//   id: "github-local",
//   token: process.env.GITHUB_TOKEN,
// });

export const slack = new Slack({ id: "my-slack-new" });
