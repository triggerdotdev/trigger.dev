import { TriggerClient } from "@trigger.dev/sdk";
import { createPagesRoute } from "@trigger.dev/nextjs";

export const client = new TriggerClient({
  id: "nextjs-12",
  apiKey: process.env.TRIGGER_API_KEY,
  apiUrl: process.env.TRIGGER_API_URL,
  verbose: false,
  ioLogLocalEnabled: true,
});

const { handler, config } = createPagesRoute(client);

export { config };

export default handler;
