import { type SampleRecord } from "../sampleRecord.js";

/**
 * WhatsApp Cloud API samples. Meta signs webhooks with `X-Hub-Signature-256: sha256=<hex>`
 * HMAC-SHA256 over the raw body, matching `presetId: "github"` exactly. `eventType` is set to
 * "messages" or "statuses" per the row hypothesis, but note this is derived from which key
 * (`value.messages` vs `value.statuses`) is present in the body, not from `changes[].field` -
 * that field is always the literal string "messages" in real Meta payloads, for both families.
 */
export const samples: SampleRecord[] = [
  {
    provider: "whatsapp",
    providerLabel: "WhatsApp (Meta)",
    presetId: "github",
    eventType: "messages",
    name: "Inbound text message",
    description: "A text message sent by a WhatsApp user to a business phone number.",
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
                messages: [
                  {
                    from: "16505551234",
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTRBNjU5OUFFRTAzODEwMTQ0RgA=",
                    timestamp: "1751416383",
                    type: "text",
                    text: { body: "Does it come in another color?" },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    },
    docsUrl:
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "whatsapp",
    providerLabel: "WhatsApp (Meta)",
    presetId: "github",
    eventType: "messages",
    name: "Inbound image message",
    description: "An image message with a caption sent by a WhatsApp user.",
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                contacts: [{ profile: { name: "Priya Shah" }, wa_id: "16505552222" }],
                messages: [
                  {
                    from: "16505552222",
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTZBQzg0MzQ4QjRCM0NGNkVGOQA=",
                    timestamp: "1751426500",
                    type: "image",
                    image: {
                      id: "1284772819503647",
                      mime_type: "image/jpeg",
                      sha256: "k7f2mA9wQeR3vN0pLxT8jZ4hC1sD6bU5nY2iG8oV7yE=",
                      caption: "Here's a photo of the item",
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    },
    docsUrl:
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/media",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "whatsapp",
    providerLabel: "WhatsApp (Meta)",
    presetId: "github",
    eventType: "messages",
    name: "Inbound interactive button reply",
    description: "A user tapping a quick-reply button from a previous business-initiated message.",
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                contacts: [{ profile: { name: "Sheena Nelson" }, wa_id: "16505551234" }],
                messages: [
                  {
                    context: {
                      from: "15550783881",
                      id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgARGBI3MEM2RUJFNkI0RENGQTVDRjUA",
                    },
                    from: "16505551234",
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQTZBQzg0MzQ4QjRCM0NGNkVGOAA=",
                    timestamp: "1751425136",
                    type: "interactive",
                    interactive: {
                      type: "button_reply",
                      button_reply: { id: "cancel-order-button", title: "Cancel order" },
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    },
    docsUrl:
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/interactive",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "whatsapp",
    providerLabel: "WhatsApp (Meta)",
    presetId: "github",
    eventType: "statuses",
    name: "Message status: sent",
    description:
      "Delivery status update after Meta accepts a business-initiated message for sending.",
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                statuses: [
                  {
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMQA=",
                    status: "sent",
                    timestamp: "1751430000",
                    recipient_id: "16505551234",
                    conversation: {
                      id: "82c14d6bd5407799e66f64d1b338e568",
                      expiration_timestamp: "1751516400",
                      origin: { type: "service" },
                    },
                    pricing: {
                      billable: true,
                      pricing_model: "PMP",
                      type: "regular",
                      category: "service",
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    },
    docsUrl:
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "whatsapp",
    providerLabel: "WhatsApp (Meta)",
    presetId: "github",
    eventType: "statuses",
    name: "Message status: delivered",
    description: "Delivery status update once the message reaches the recipient's device.",
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                statuses: [
                  {
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMAA=",
                    status: "delivered",
                    timestamp: "1751430074",
                    recipient_id: "16505553333",
                    conversation: {
                      id: "72b14d6bd5407799e66f64d1b338e567",
                      expiration_timestamp: "1751516480",
                      origin: { type: "service" },
                    },
                    pricing: {
                      billable: true,
                      pricing_model: "PMP",
                      type: "regular",
                      category: "service",
                    },
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    },
    docsUrl:
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "whatsapp",
    providerLabel: "WhatsApp (Meta)",
    presetId: "github",
    eventType: "statuses",
    name: "Message status: failed",
    description: "Delivery status update when a message fails to send, with error detail.",
    body: {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "102290129340398",
          changes: [
            {
              value: {
                messaging_product: "whatsapp",
                metadata: {
                  display_phone_number: "15550783881",
                  phone_number_id: "106540352242922",
                },
                statuses: [
                  {
                    id: "wamid.HBgLMTY1MDM4Nzk0MzkVAgASGBQzQUFERjg0NDEzNDdFODU3MUMxMgA=",
                    status: "failed",
                    timestamp: "1751431301",
                    recipient_id: "16505554444",
                    errors: [
                      {
                        code: 131026,
                        title: "Message undeliverable",
                        message: "Message undeliverable",
                        error_data: {
                          details:
                            "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
                        },
                        href: "https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes/",
                      },
                    ],
                  },
                ],
              },
              field: "messages",
            },
          ],
        },
      ],
    },
    docsUrl:
      "https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/status",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
