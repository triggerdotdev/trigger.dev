import { Trigger } from "@trigger.dev/sdk";
import { github } from "@trigger.dev/integrations";

new Trigger({
  id: "github-webhook-9",
  name: "GitHub issue: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: github.events.issueEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
}).listen();

new Trigger({
  id: "github-webhook-pull_request",
  name: "GitHub PR: triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: github.events.pullRequestEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
}).listen();
