This repo contains a [GitHub newStarEvent](https://docs.trigger.dev/integrations/apis/github/events/new-star) Trigger that will run whenever the specified repository gets a new ⭐️:

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

## ✍️ Customize

1. Make sure and update the `repo` parameter to point to a GitHub repository you manage by setting the `GITHUB_REPOSITORY` environment variable.
2. Feel free to customize [postMessage](https://docs.trigger.dev/integrations/apis/slack/actions/post-message) call with more data from the [newStar Event](https://docs.trigger.dev/integrations/apis/github/events/new-star#event) and change the channel name.

## 🧪 Test it

After successfully running this template locally, head over to your [Trigger.dev Dashboard](https://app.trigger.dev) and you should see your newly created workflow:

![workflow list](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/9987dd75-7e0e-4e3f-9280-0ee6d7ad1e00/public)

Click on the workflow in the list and you should come to the Workflow overview page, with a message detailing that you need to authenticate to GitHub to register the webhook for the [newStarEvent](https://docs.trigger.dev/integrations/apis/github/events/new-star):

![workflow overview](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/6e658b62-444f-463a-21ba-43edc91bce00/public)

After connecting to your GitHub account, you'll be redirected back to your Workflow Overview page and the message should be gone (you sometimes need to refresh a few times because we register the webhook in the background):

![workflow connected](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/abcf4856-18ef-45ec-3da6-82d49dc32b00/public)

If you head over to your repo, you should see the newly registered webhook:

![webhook registered](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3248e9df-d16e-4585-fa25-2374bed53000/public)

The easiest way to fire off the `newStarEvent` is to go ahead and star the repo (in this case it's [this repo](https://github.com/triggerdotdev/github-stars-to-slack)). Head back to the Workflow Overview page and you should see a run is in progress:

![workflow run started](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/623f27b3-263a-4562-cdc9-92462e3a7400/public)

Navigate to the Run Details page (by clicking on the run in the list) and you'll notice the "post message to github-stars" step has paused, waiting for your Slack authentication:

![slack auth](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/3214985e-05c3-493e-55fd-2ed799c7c500/public)

Once you authenticate your Slack workspace, the run will pickup where it left off and post the message:

![post message](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/e43c2b11-4b70-4de1-2ebf-b92943d99400/public)

Head over to slack to see your newly created message:

![slack message](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/5c238a76-22ee-4837-9379-e3c673211100/public)
