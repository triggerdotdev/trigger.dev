export function webhook(apiKey: string) {
  return `import { webhookEvent, Trigger } from "@trigger.dev/sdk";
import { z } from "zod";

new Trigger({
  //todo: ensure this id is only used for this workflow
  id: "caldotcom-to-slack",
  name: "Cal.com To Slack",
  // For security, we recommend moving this api key to your .env / secrets file. 
  // Our env variable is called TRIGGER_API_KEY
  apiKey: "${apiKey}",
  //todo setup your custom webhook. 
  //we have integrations that make this much easier for supported APIs
  on: webhookEvent({
    service: "cal.com",
    //the name of the event you want to subscribe for
    eventName: "BOOKING_CREATED",
    filter: {
      triggerEvent: ["BOOKING_CREATED"],
    },
    //you can define a schema to validate the payload, and have nice types in the run function
    //here we use z.any() to accept any payload
    schema: z.any(),
    //some webhooks are signed, set the header name and we'll verify the signature for you
    verifyPayload: {
      enabled: true,
      header: "X-Cal-Signature-256",
    },
  }),
  run: async (event, ctx) => {
    //insert your code here
  },
}).listen();`;
}
