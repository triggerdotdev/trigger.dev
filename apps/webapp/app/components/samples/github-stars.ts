export function githubStars(apiKey: string) {
  return `import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as slack from "@trigger.dev/slack";

new Trigger({
  id: "new-github-star-to-slack",
  name: "New GitHub Star: triggerdotdev/trigger.dev",
  apiKey: "${apiKey}",
  on: github.events.newStarEvent({
    repo: "triggerdotdev/trigger.dev",
  }),
  run: async (event) => {
    await slack.postMessage("github-stars", {
      channelName: "github-stars",
      text: \`New GitHub star from \n<\${event.sender.html_url}|\${event.sender.login}>\`,
    });
  },
}).listen();`;
}
