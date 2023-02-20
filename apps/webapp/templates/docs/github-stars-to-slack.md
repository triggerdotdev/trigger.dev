This repo contains a [GitHub newStarEvent](https://docs.trigger.dev/integrations/apis/github/events/new-star) Trigger that will run whenever the specified repository gets a new ⭐️:

```ts
import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as slack from "@trigger.dev/slack";

const repo =
  process.env.GITHUB_REPOSITORY ?? "triggerdotdev/github-stars-to-slack";

new Trigger({
  // Give your Trigger a stable ID
  id: "github-stars-to-slack",
  name: "GitHub Stars to Slack",
  // This will register a webhook with the repo
  // and trigger whenever the repo gets a new star
  on: github.events.newStarEvent({
    repo,
  }),
  // The run function will get called once per "new star" event
  // See https://docs.trigger.dev/integrations/apis/github/events/new-star
  run: async (event) => {
    // Posts a new message to the "github-stars" slack channel.
    // See https://docs.trigger.dev/integrations/apis/slack/actions/post-message
    await slack.postMessage("⭐️", {
      channelName: "github-stars",
      text: `New GitHub star from \n<${event.sender.html_url}|${event.sender.login}>. You now have ${event.repository.stargazers_count} stars!`,
    });
  },
}).listen();
```

## ✍️ Customize

1. Make sure and update the `repo` parameter to point to a GitHub repository you manage by setting the `GITHUB_REPOSITORY` environment variable.
2. Feel free to customize [postMessage](https://docs.trigger.dev/integrations/apis/slack/actions/post-message) call with more data from the [newStar Event](https://docs.trigger.dev/integrations/apis/github/events/new-star#event) and change the channel name.
