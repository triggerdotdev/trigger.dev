This repo is a very simple starting point for creating your Trigger.dev workflows.

Currently this repo only has a single [customEvent](https://docs.trigger.dev/triggers/custom-events) trigger:

```ts
import { Trigger, customEvent } from "@trigger.dev/sdk";
import { z } from "zod";

new Trigger({
  // Give your Trigger a stable ID
  id: "basic-starter",
  name: "Basic Starter",
  // Trigger on a custom event, see https://docs.trigger.dev/triggers/custom-events
  on: customEvent({
    name: "basic.starter",
    // Use zod to verify event payload. See https://docs.trigger.dev/guides/zod
    schema: z.object({ id: z.string() }),
  }),
  // The run functions gets called once per "basic.starter" event
  async run(event, ctx) {
    // Call external services, add delays, and more here.
    await ctx.logger.info("Hello world from inside trigger.dev");

    // Returned data will become the run "output" and is optional
    return event;
  },
}).listen();
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

## 📺 Go Live

After you are happy with your campaign and deploy it live to Render.com (or some other hosting service), you can send custom events that Trigger your workflow using the [sendEvent](https://docs.trigger.dev/reference/send-event) function from the `@trigger.dev/sdk`, or simply by making requests to our [`events`](https://docs.trigger.dev/api-reference/events/sendEvent) API endpoint.

Here is an example of sending the custom event to trigger the workflow contained in this repo using `fetch`:

```ts
const eventId = ulid(); // Generate a unique event ID
const event = {
  name: "basic.starter",
  payload: {
    // This should match the zod schema provided in the `customEvent.schema` option
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
