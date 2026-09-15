import { type SampleRecord } from "../sampleRecord.js";

/**
 * Telegram Bot API Update samples. An Update carries exactly one of several optional keys (message,
 * edited_message, callback_query, inline_query, ...) and that key name IS the event type - there is no
 * separate `type` field. Auth is a static shared secret compared against the
 * X-Telegram-Bot-Api-Secret-Token header (set via `secret_token` on `setWebhook`), not an HMAC/Ed25519
 * signature, so these ship sample-only (no `presetId`).
 */
export const samples: SampleRecord[] = [
  {
    provider: "telegram",
    providerLabel: "Telegram",
    eventType: "message",
    name: "Message",
    description: "An incoming text message in a private chat.",
    body: {
      update_id: 397587257,
      message: {
        message_id: 486,
        from: {
          id: 927485618,
          is_bot: false,
          first_name: "Priya",
          last_name: "Nair",
          username: "priyanair",
          language_code: "en",
        },
        chat: {
          id: 927485618,
          first_name: "Priya",
          last_name: "Nair",
          username: "priyanair",
          type: "private",
        },
        date: 1752562800,
        text: "Hey, is the shipment on track for Friday?",
      },
    },
    docsUrl: "https://core.telegram.org/bots/api#setwebhook",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "telegram",
    providerLabel: "Telegram",
    eventType: "edited_message",
    name: "Edited message",
    description: "The sender edited a previously sent message. `edit_date` marks when.",
    body: {
      update_id: 397587258,
      edited_message: {
        message_id: 486,
        from: {
          id: 927485618,
          is_bot: false,
          first_name: "Priya",
          last_name: "Nair",
          username: "priyanair",
          language_code: "en",
        },
        chat: {
          id: 927485618,
          first_name: "Priya",
          last_name: "Nair",
          username: "priyanair",
          type: "private",
        },
        date: 1752562800,
        edit_date: 1752562845,
        text: "Hey, is the shipment on track for next Friday?",
      },
    },
    docsUrl: "https://core.telegram.org/bots/api#setwebhook",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "telegram",
    providerLabel: "Telegram",
    eventType: "callback_query",
    name: "Callback query",
    description:
      "A user tapped an inline keyboard button. `data` is the button's opaque payload; `chat_instance` scopes the tap to the chat it happened in.",
    body: {
      update_id: 397587259,
      callback_query: {
        id: "4382174950123456789",
        from: {
          id: 927485618,
          is_bot: false,
          first_name: "Priya",
          last_name: "Nair",
          username: "priyanair",
          language_code: "en",
        },
        message: {
          message_id: 490,
          from: {
            id: 6473920185,
            is_bot: true,
            first_name: "OrderStatusBot",
            username: "order_status_bot",
          },
          chat: {
            id: 927485618,
            first_name: "Priya",
            last_name: "Nair",
            username: "priyanair",
            type: "private",
          },
          date: 1752563100,
          text: "Choose a shipment to track:",
        },
        chat_instance: "-4827193650918273645",
        data: "track_shipment:SHP-58213",
      },
    },
    docsUrl: "https://core.telegram.org/bots/api#setwebhook",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "telegram",
    providerLabel: "Telegram",
    eventType: "inline_query",
    name: "Inline query",
    description:
      "The user typed `@botname ...` in any chat; `query` is the text typed after the mention.",
    body: {
      update_id: 397587260,
      inline_query: {
        id: "1836452901847362910",
        from: {
          id: 927485618,
          is_bot: false,
          first_name: "Priya",
          last_name: "Nair",
          username: "priyanair",
          language_code: "en",
        },
        query: "shipment SHP-58213",
        offset: "",
      },
    },
    docsUrl: "https://core.telegram.org/bots/api#setwebhook",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
