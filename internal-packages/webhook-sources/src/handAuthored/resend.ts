import { type SampleRecord } from "../sampleRecord.js";

/**
 * Resend samples. Resend signs webhooks with Svix (`svix-id`/`svix-timestamp`/`svix-signature`
 * headers, HMAC-SHA256 base64 over `{id}.{timestamp}.{rawBody}`, `whsec_`-prefixed secret), so
 * `presetId: "svix"` keeps them under the round-trip guarantee. `broadcast_id`/`template_id` only
 * appear on `data` when the email was sent as part of a Broadcast or with a Template.
 */
export const samples: SampleRecord[] = [
  {
    provider: "resend",
    providerLabel: "Resend",
    presetId: "svix",
    eventType: "email.sent",
    name: "Email sent",
    description:
      "Resend accepted the API request and is attempting delivery to the recipient's mail server.",
    body: {
      type: "email.sent",
      created_at: "2026-06-18T09:12:03.041Z",
      data: {
        created_at: "2026-06-18T09:12:02.884Z",
        email_id: "4ef9a417-02e9-4d39-8e9d-3f1c6a2b9c11",
        message_id: "<a1b2c3d4-e5f6-7890-abcd-ef1234567890@email.example.com>",
        from: "Acme <onboarding@acme.dev>",
        to: ["jamie@example.com"],
        subject: "Welcome to Acme",
        tags: { category: "welcome_email" },
      },
    },
    docsUrl: "https://resend.com/docs/dashboard/webhooks/introduction",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "resend",
    providerLabel: "Resend",
    presetId: "svix",
    eventType: "email.delivered",
    name: "Email delivered",
    description: "The recipient's mail server accepted the email.",
    body: {
      type: "email.delivered",
      created_at: "2026-06-18T09:12:41.317Z",
      data: {
        broadcast_id: "8f2c6d7a-1b3e-4a9c-9d5f-6e2a8b4c7f10",
        created_at: "2026-06-18T09:12:40.955Z",
        email_id: "7c3e9a52-6f18-4d2b-b9a7-1e5c8f3d2a64",
        message_id: "<b2c3d4e5-f6a7-8901-bcde-f23456789012@email.example.com>",
        from: "Acme <news@acme.dev>",
        to: ["morgan@example.com"],
        subject: "Your July product update",
        template_id: "d4e5f6a7-8b9c-4d1e-af23-456789012bcd",
        tags: { category: "newsletter" },
      },
    },
    docsUrl: "https://resend.com/docs/dashboard/webhooks/introduction",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "resend",
    providerLabel: "Resend",
    presetId: "svix",
    eventType: "email.bounced",
    name: "Email bounced",
    description: "The recipient's mail server permanently rejected the email.",
    body: {
      type: "email.bounced",
      created_at: "2026-06-18T09:13:05.662Z",
      data: {
        created_at: "2026-06-18T09:13:05.201Z",
        email_id: "9b1d4f7a-2c5e-4b8d-a1f3-6c9e2b5d8a17",
        message_id: "<c3d4e5f6-a7b8-9012-cdef-345678901234@email.example.com>",
        from: "Acme <onboarding@acme.dev>",
        to: ["taylor@example.com"],
        subject: "Confirm your email address",
        bounce: {
          type: "Permanent",
          subType: "Suppressed",
          message:
            "The recipient's email address is on the suppression list because it has a recent history of producing hard bounces.",
        },
        tags: { category: "confirm_email" },
      },
    },
    docsUrl: "https://resend.com/docs/dashboard/webhooks/introduction",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "resend",
    providerLabel: "Resend",
    presetId: "svix",
    eventType: "email.complained",
    name: "Email complained",
    description: "The email was delivered, but the recipient marked it as spam.",
    body: {
      type: "email.complained",
      created_at: "2026-06-18T09:14:22.108Z",
      data: {
        created_at: "2026-06-18T09:14:21.774Z",
        email_id: "2a5c8e1b-4d7f-4a3c-9b6e-8f1c4a7d2e59",
        message_id: "<d4e5f6a7-b8c9-0123-defa-456789012345@email.example.com>",
        from: "Acme <deals@acme.dev>",
        to: ["riley@example.com"],
        subject: "Flash sale ends tonight",
        tags: { category: "promo" },
      },
    },
    docsUrl: "https://resend.com/docs/dashboard/webhooks/introduction",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "resend",
    providerLabel: "Resend",
    presetId: "svix",
    eventType: "email.opened",
    name: "Email opened",
    description: "The recipient opened the email.",
    body: {
      type: "email.opened",
      created_at: "2026-06-18T09:20:11.933Z",
      data: {
        created_at: "2026-06-18T09:12:02.884Z",
        email_id: "4ef9a417-02e9-4d39-8e9d-3f1c6a2b9c11",
        message_id: "<a1b2c3d4-e5f6-7890-abcd-ef1234567890@email.example.com>",
        from: "Acme <onboarding@acme.dev>",
        to: ["jamie@example.com"],
        subject: "Welcome to Acme",
        tags: { category: "welcome_email" },
      },
    },
    docsUrl: "https://resend.com/docs/dashboard/webhooks/introduction",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "resend",
    providerLabel: "Resend",
    presetId: "svix",
    eventType: "email.clicked",
    name: "Email link clicked",
    description: "The recipient clicked a link inside the email.",
    body: {
      type: "email.clicked",
      created_at: "2026-06-18T09:25:47.502Z",
      data: {
        created_at: "2026-06-18T09:12:40.955Z",
        email_id: "7c3e9a52-6f18-4d2b-b9a7-1e5c8f3d2a64",
        message_id: "<b2c3d4e5-f6a7-8901-bcde-f23456789012@email.example.com>",
        from: "Acme <news@acme.dev>",
        to: ["morgan@example.com"],
        subject: "Your July product update",
        template_id: "d4e5f6a7-8b9c-4d1e-af23-456789012bcd",
        click: {
          link: "https://acme.dev/pricing",
          ipAddress: "203.0.113.42",
          timestamp: "2026-06-18T09:25:47.502Z",
          userAgent:
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
        },
        tags: { category: "newsletter" },
      },
    },
    docsUrl: "https://resend.com/docs/dashboard/webhooks/introduction",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
