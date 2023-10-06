import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "package-tester",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});
