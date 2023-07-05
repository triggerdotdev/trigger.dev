
import { TriggerClient } from "@trigger.dev/sdk";

export const client = new TriggerClient({
  id: "nextjs-pages",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
});
  