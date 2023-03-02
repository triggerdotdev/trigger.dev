This template uses [Supabase Webhooks](https://supabase.com/docs/guides/database/webhooks) with the generic [webhookEvent](https://docs.trigger.dev/reference/webhook-event) trigger to send updates whenever a user record is created in a Supabase table to [Loops.so](https://loops.so), the Loops.so API and our generic [fetch](https://docs.trigger.dev/functions/fetch) function.

```ts
import { secureString, Trigger, webhookEvent } from "@trigger.dev/sdk";

new Trigger({
  // Give your Trigger a stable ID
  id: "supabase-to-loops",
  name: "Supabase to Loops.so",
  // Trigger on a webhook event, see https://docs.trigger.dev/triggers/webhooks
  on: webhookEvent({
    service: "supabase", // this is arbitrary, you can set it to whatever you want
    eventName: "user.inserted", // this is arbitrary, you can set it to whatever you want
    filter: {
      type: ["INSERT"], // only trigger on INSERT events
      table: ["users"], // only trigger on the users table
    },
  }),
  // The payload of the webhook is passed as the event argument
  async run(event, ctx) {
    if (!process.env.LOOPS_API_KEY) {
      throw new Error("Missing LOOPS_API_KEY environment variable");
    }

    await ctx.fetch(
      "Send to Loops",
      "https://app.loops.so/api/v1/contacts/create",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: secureString`Bearer ${process.env.LOOPS_API_KEY}`,
        },
        body: {
          email: event.record.email,
          createdAt: event.record.created_at,
          firstName: event.record.first_name,
          lastName: event.record.last_name,
          userId: String(event.record.id),
        },
      }
    );
  },
}).listen();
```

## 🔁 Get your Loops.so API Key

Follow the instructions in [the Loops.so API docs](https://tryloops.notion.site/API-5b453a52dd7c4b419aa4647410de9770) for how to get your API Key.

Once you have the API Key from Loops, set the `LOOPS_API_KEY` env variable in the `.env` file at the root of this project:

```
LOOPS_API_KEY="your Loops api key here"
```
