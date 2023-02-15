import { WebhookExample } from "@trigger.dev/integration-sdk/types";

export const examples: Record<string, WebhookExample> = {
  messages: {
    name: "WhatsApp message received",
    payload: {
      type: "message",
      message: {
        id: "wamid.HBgMNDQ3NzQ2NTI5MzI3FQIAEhgUM0VCMDJFQzNEMjhDQTYzNkEzQTMA",
        from: "11234567890",
        text: {
          body: "This is a regular WhatsApp message as an example",
        },
        type: "text",
        timestamp: 1675427820000,
      },
      contacts: [
        {
          wa_id: "11234567890",
          profile: {
            name: "Chloe Blake",
          },
        },
      ],
      metadata: {
        phone_number_id: "102119172798942",
        display_phone_number: "15550172002",
      },
    },
  },
};
