
import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "jobs-starter",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});
  