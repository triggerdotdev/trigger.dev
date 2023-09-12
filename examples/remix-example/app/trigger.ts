import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "remix-test",
  apiKey: process.env.TRIGGER_API_KEY,
});
