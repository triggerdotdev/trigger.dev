This repo is a very simple starting point for creating your Trigger.dev workflows.

Currently this repo only has a single [customEvent](https://docs.trigger.dev/triggers/custom-events) trigger:

```ts
import { Trigger, customEvent } from "@trigger.dev/sdk";
import { z } from "zod";

new Trigger({
  id: "basic-starter",
  name: "Basic Starter",
  on: customEvent({
    name: "basic.starter",
    schema: z.object({ id: z.string() }),
  }),
  async run(event, ctx) {
    await ctx.logger.info("Hello world from inside trigger.dev");

    return event;
  },
}).listen();
```

## 🧪 Test it

After successfully running this template locally, head over to your [Trigger.dev Dashboard](https://app.trigger.dev) and you should see your newly created workflow:

![workflow list](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/34fb0fa8-3649-4c8e-4b27-d31540f3cb00/width=1200)

Click on the workflow in the list and you should come to the Workflow overview page:

![workflow overview](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/8d68044b-104f-472c-837f-dd1ca62e9d00/width=1200)

Click on the "Test your workflow" button and fill in the JSON needed for [this workflow's](src/index.ts#L7) customEvent Trigger:

![workflow test](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/dbfdfeed-4230-44ec-5e6c-1e87412a5200/width=1200)

After click "Run Test" you'll be redirected to the Run Details page:

![workflow run](https://imagedelivery.net/3TbraffuDZ4aEf8KWOmI_w/18b46eaa-95d1-49c5-774f-507819360a00/width=1200)

## 📺 Go Live

After you are happy with your campaign and deploy it live to Render.com (or some other hosting service), you can send custom events that Trigger your workflow using the [sendEvent](https://docs.trigger.dev/reference/send-event) function from the `@trigger.dev/sdk`, or simply by making requests to our [`events`](https://docs.trigger.dev/api-reference/events/sendEvent) API endpoint.

Here is an example of sending the custom event to trigger the workflow contained in this repo using `fetch`:

```ts
const eventId = ulid();
const event = {
  name: "basic.starter",
  payload: {
    id: "user_1234",
  },
};

const response = await fetch("https://app.trigger.dev/api/v1/events", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${process.env.TRIGGER_API_KEY}`,
  },
  body: JSON.stringify({
    id: eventId,
    event,
  }),
});
```

## ✍️ Customize

You can easily adapt this workflow to a different event relevant to your app. For example, we have a workflow that runs when a user is created and it looks like this:

```ts
import { Trigger, customEvent } from "@trigger.dev/sdk";
import * as slack from "@trigger.dev/slack";
import { z } from "zod";

new Trigger({
  id: "new-user",
  name: "New user",
  on: customEvent({
    name: "user.created",
    schema: z.object({ id: z.string() }),
  }),
  async run(event, ctx) {
    const user = await prisma.user.find({
      where: { id: event.id },
    });

    await slack.postMessage("🚨", {
      channelName: "new-users",
      text: `New user signed up: ${user.email}`,
    });
  },
}).listen();
```

Be sure to check out more over on our [docs](https://docs.trigger.dev)
