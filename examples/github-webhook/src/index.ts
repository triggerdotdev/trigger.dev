import { Trigger } from "@trigger.dev/sdk";
import { github } from "@trigger.dev/integrations";

const trigger = new Trigger({
  id: "github-webhook-9",
  name: "GitHub changes made to triggerdotdev/trigger.dev-examples",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: github.events.repoIssueEvent({
    repo: "triggerdotdev/trigger.dev-examples",
  }),
  run: async (event, ctx) => {
    await ctx.logger.info(`Action was ${event.action}`);

    return {};
  },
});

trigger.listen();
