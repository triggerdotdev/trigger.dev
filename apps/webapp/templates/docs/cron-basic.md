This repo contains a simple CRON job workflow that runs every weekday at 9:00 AM UTC.

It is a great starting point for creating your own scheduled workflows.

To easily create CRON schedules, we recommend using [crontab.guru](https://crontab.guru/).

```ts
import { Trigger, scheduleEvent } from "@trigger.dev/sdk";

new Trigger({
  // Give your Trigger a stable ID
  id: "cron-basic",
  name: "Trigger event at 9am every weekday",
  //Trigger this event at 09:00 on every day-of-week from Monday through Friday. (https://crontab.guru/#0_9_*_*_1-5)
  on: scheduleEvent({ cron: "0 9 * * 1-5" }),
  run: async (event, ctx) => {
    // This can be anything - e.g. update your database, send an email or post a daily Slack update etc
    // Create a log at the correct time
    await ctx.logger.info("Received the cron scheduled event", {
      event,
    });
  },
}).listen();
```

## 🔧 Install

You can easily create a new project interactively based on this template by running:

```sh
npx create-trigger@latest cron-basic
# or
yarn create trigger cron-basic
# or
pnpm create trigger@latest cron-basic
```

Follow the instructions in the CLI to get up and running locally in <30s.

### 🧪 Test it

After successfully running this template locally, head over to your [Trigger.dev Dashboard](https://app.trigger.dev) and you should see your newly created workflow.

## ✍️ Customize

You can easily adapt this workflow for example, we have a workflow that runs once a year on the 1st of January and posts a Slack message wishing our team a Happy New Year.

```ts
import { Trigger, scheduleEvent } from "@trigger.dev/sdk";
import * as slack from "@trigger.dev/slack";

new Trigger({
  // Give your Trigger a stable ID
  id: "cron-happy-new-year",
  name: "Happy New Year!",

  //Trigger this event at 12am every 1st of January, every year.
  on: scheduleEvent({ cron: "0 12 1 1 *" }),
  run: async (event, ctx) => {
    // This can be anything - e.g. update your database, send an email or post a daily Slack update etc
    // log the event at the correct time
    await slack.postMessage("🚨", {
      channelName: "happy-new-year",
      text: `🎉 Happy New Year team! 🎉 `,
    });
  },
}).listen();
```

Be sure to check out more over on our [docs](https://docs.trigger.dev)
