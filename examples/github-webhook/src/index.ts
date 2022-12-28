import { Trigger } from "@trigger.dev/sdk";
import { github } from "@trigger.dev/integrations";

const trigger = new Trigger({
  id: "github-webhook-9",
  name: "GitHub Issue changes for jsonhero-web",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: github.repoIssueEvent({ repo: "apihero-run/jsonhero-web" }),
  run: async (event, ctx) => {
    await ctx.logger.info(
      "Inside the github-webhook workflow, received event",
      {
        event,
      }
    );

    if (event.action === "assigned") {
      await ctx.logger.info(`New assignee: ${event.assignee.login}`);
      // await slack.sendMessage({
      //   channel: "C01BQKZJZ7M",
      //   text: `New issue: ${event.issue.title}`,
      // });
    }

    return event;
  },
});

trigger.listen();
