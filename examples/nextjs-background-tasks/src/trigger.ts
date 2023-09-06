import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "background-tasks-z2kp",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});
