import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "astro-test",
  apiUrl: import.meta.env.TRIGGER_API_URL,
  apiKey: import.meta.env.TRIGGER_API_KEY,
});
