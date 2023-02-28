This template uses [Supabase Webhooks](https://supabase.com/docs/guides/database/webhooks) with the generic [webhookEvent](https://docs.trigger.dev/reference/webhook-event) trigger to send updates whenever a record is created in a Supabase table to Discord, using [Discord incoming webhooks](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) and our generic [fetch](https://docs.trigger.dev/functions/fetch) function.

```ts
import { Trigger, webhookEvent } from "@trigger.dev/sdk";

const SUPABASE_TABLE = process.env.SUPABASE_TABLE ?? "users";
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

new Trigger({
  // Give your Trigger a stable ID
  id: "supabase-to-discord",
  name: "Supabase to Discord",
  // Trigger on a webhook event, see https://docs.trigger.dev/triggers/webhooks
  on: webhookEvent({
    service: "supabase", // this is arbitrary, you can set it to whatever you want
    eventName: "row.inserted", // this is arbitrary, you can set it to whatever you want
    filter: {
      type: ["INSERT"], // only trigger on INSERT events
      table: [SUPABASE_TABLE], // only trigger
    },
  }),
  // The payload of the webhook is passed as the event argument
  async run(event, ctx) {
    // Check that the DISCORD_WEBHOOK_URL environment variable is set
    if (!DISCORD_WEBHOOK_URL) {
      throw new Error("DISCORD_WEBHOOK_URL is not set");
    }

    // Craft a message to send to Discord
    const message = {
      embeds: [
        {
          color: 0x7289da,
          title: `New row created in ${event.table}: ${event.record.email}`,
        },
      ],
    };

    // Send the message to Discord using the incoming webhook URL
    await ctx.fetch("✨", DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: message,
    });
  },
}).listen();
```

## ✍️ Customize

1. Change the table using the `SUPABASE_TABLE` environment variable to point to the table you'd like events from in your supabase database.
2. Feel free to customize the message to Discord by referencing [their docs](https://discord.com/developers/docs/resources/webhook#execute-webhook)
