
import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "outdated-packages-4Jq5",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});
  