export function webhook(apiKey: string) {
  return `import { webhookEvent, Trigger } from "@trigger.dev/sdk";
import { z } from "zod";

new Trigger({
  id: "caldotcom-to-slack",
  name: "Cal.com To Slack",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  on: webhookEvent({
    service: "cal.com",
    eventName: "BOOKING_CREATED",
    filter: {
      triggerEvent: ["BOOKING_CREATED"],
    },
    schema: z.any(),
    verifyPayload: {
      enabled: true,
      header: "X-Cal-Signature-256",
    },
  }),
  run: async (event, ctx) => {},
}).listen();`;
}
