## ✨ Trigger.dev Basic Starter

This repo is a basic starting point that has a single (very simple) trigger:

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

This trigger can be run by sending the following event (using our [sendEvent](https://docs.trigger.dev/functions/send-event) function):

```ts
import { sendEvent } from "@trigger.dev/sdk";
import { randomUUID } from "node:crypto";

// make sure to have your API Key in process.env.TRIGGER_API_KEY
await sendEvent(randomUUID(), {
  name: "basic.starter",
  payload: { id: "123456" },
});
```
