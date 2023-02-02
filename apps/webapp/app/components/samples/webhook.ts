
export function webhook() {
return `import { webhookEvent, Trigger } from "@trigger.dev/sdk";

new Trigger({
  id: "caldotcom-to-slack",
  name: "Cal.com To Slack",
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