## ✨ Trigger.dev GitHub Stars to Slack

This template contains a [GitHub newStarEvent](https://docs.trigger.dev/integrations/apis/github/events/new-star) Trigger that will run whenever the specified repository gets a new ⭐️:

```ts
import { Trigger } from "@trigger.dev/sdk";
import * as github from "@trigger.dev/github";
import * as slack from "@trigger.dev/slack";

const repo =
  process.env.GITHUB_REPOSITORY ?? "triggerdotdev/github-stars-to-slack";

new Trigger({
  id: "github-stars-to-slack",
  name: "GitHub Stars to Slack",
  on: github.events.newStarEvent({
    repo,
  }),
  run: async (event) => {
    await slack.postMessage("⭐️", {
      channelName: "github-stars",
      text: `New GitHub star from \n<${event.sender.html_url}|${event.sender.login}>. You now have ${event.repository.stargazers_count} stars!`,
    });
  },
}).listen();
```

## ✍️ Customize it

1. Make sure and set the `GITHUB_REPOSITORY` environment variable to a repo that you manage.
2. Feel free to customize [postMessage](https://docs.trigger.dev/integrations/apis/slack/actions/post-message) call with more data from the [newStar Event](https://docs.trigger.dev/integrations/apis/github/events/new-star#event)
