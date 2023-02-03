export function githubIssues(apiKey: string) {
  return `import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as slack from "@trigger.dev/slack";

new Trigger({
  id: "github-issues-to-slack",
  name: "Posts to Slack when GitHub Issue created or modified",
  apiKey: "${apiKey}",
  on: github.events.issueEvent({
    repo: "my-github-org/my-github-repo",
  }),

  run: async (event, ctx) => {
    const response = await slack.postMessage("send-to-slack", {
      channelName: "my-slack-channel-name",
      text: \`A new issue has been created or modified. \${event.action}\`,
    });

    return response.message;
  },
}).listen();`;
}
