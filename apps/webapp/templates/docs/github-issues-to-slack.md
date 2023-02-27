This template contains a [GitHub IssueEvent](https://docs.trigger.dev/integrations/apis/github/events/issues) Trigger that will run whenever an issue action is performed in a GitHub repository:

```ts
import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as slack from "@trigger.dev/slack";

const repo =
  process.env.GITHUB_REPOSITORY ?? "triggerdotdev/github-issues-to-slack";

new Trigger({
  // Give your Trigger a stable ID
  id: "github-issues-to-slack",
  name: "Posts to Slack when a GitHub Issue is created or modified",
  // This will register a webhook with the repo
  // and trigger whenever a new issue is created or modified
  on: github.events.issueEvent({
    repo,
  }),
  // The run function will get called once per "issue" event
  // See https://docs.trigger.dev/integrations/apis/github/events/issues
  run: async (event, ctx) => {
    // Posts a new message to the "github-issues" slack channel.
    // See https://docs.trigger.dev/integrations/apis/slack/actions/post-message
    // If the channel is private, you'll need to add the Trigger.dev bot to the channel first.
    const response = await slack.postMessage("send-to-slack", {
      channelName: "github-issues",
      // If you include blocks, this text will be used in any notifications.
      text: `GitHub issue, *${event.issue.title}* has been *${event.action}*. `,
      // Blocks allow you to create richly formatted messages.
      // See https://api.slack.com/tools/block-kit-builder
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `GitHub issue, *${event.issue.title}* has been *${event.action}*.`,
          },
          accessory: {
            type: "button",
            text: {
              type: "plain_text",
              text: "View Issue",
              emoji: true,
            },
            value: "View Issue",
            url: event.issue.html_url,
            action_id: "button-action",
          },
        },
      ],
    });
  },
}).listen();
```

## An example of the message posted to Slack:

![GitHub Issue to Slack](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/c6a66532-8ab6-4e14-83b6-4333731fe200/public)

## ✍️ Customize

1. Make sure and update the `repo` parameter to point to a GitHub repository you manage by setting the `GITHUB_REPOSITORY` environment variable.
2. Feel free to customize [postMessage](https://docs.trigger.dev/integrations/apis/slack/actions/post-message) call with more data from the [GitHub IssueEvent](https://docs.trigger.dev/integrations/apis/github/events/issues) and change the channel name.

You can also do this with [comments](https://docs.trigger.dev/integrations/apis/github/events/issue-comments) , [pull requests](https://docs.trigger.dev/integrations/apis/github/events/pull-requests), and more.
