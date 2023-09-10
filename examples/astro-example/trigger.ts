import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "astro-test",
  apiKey: process.env.TRIGGER_API_KEY,
});
