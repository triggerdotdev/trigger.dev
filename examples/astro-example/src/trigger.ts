import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "astro-test",
  apiKey: import.meta.env.TRIGGER_API_KEY
});
