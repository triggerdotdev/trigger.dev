import { type SampleRecord } from "../sampleRecord.js";

/**
 * SendGrid Event Webhook samples. SendGrid signs with ECDSA (`X-Twilio-Email-Event-Webhook-Signature`
 * + `-Timestamp` headers, verified with an EC public key SendGrid issues), which does not match any of
 * our verifier presets, so these ship sample-only (no `presetId`). SendGrid always POSTs a JSON ARRAY
 * of event objects in one batch; each sample here is a single-element array holding one representative
 * event, and `eventType` is that event's `event` value.
 */
export const samples: SampleRecord[] = [
  {
    provider: "sendgrid",
    providerLabel: "SendGrid",
    eventType: "delivered",
    name: "Email delivered",
    description: "SendGrid accepted and delivered the message to the receiving server.",
    body: [
      {
        email: "jordan@example.com",
        timestamp: 1752562800,
        "smtp-id": "<14c5d75ce93.dfd.64b469@ismtpd-555>",
        event: "delivered",
        category: ["welcome-series"],
        sg_event_id: "rWVYmVk90MjZJ9iohOBa3w_fake==",
        sg_message_id: "14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0",
        response: "250 OK",
        asm_group_id: 1,
      },
    ],
    docsUrl: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "sendgrid",
    providerLabel: "SendGrid",
    eventType: "open",
    name: "Email opened",
    description:
      "The recipient opened the message. `sg_machine_open` flags automated/prefetch opens.",
    body: [
      {
        email: "jordan@example.com",
        timestamp: 1752563400,
        event: "open",
        sg_machine_open: false,
        category: ["welcome-series"],
        sg_event_id: "FOTFFO0ecsBE-zxFXfs6WA_fake==",
        sg_message_id: "14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0",
        useragent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
        ip: "198.51.100.23",
      },
    ],
    docsUrl: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "sendgrid",
    providerLabel: "SendGrid",
    eventType: "click",
    name: "Link clicked",
    description: "The recipient clicked a tracked link in the message.",
    body: [
      {
        email: "jordan@example.com",
        timestamp: 1752564000,
        event: "click",
        category: ["welcome-series"],
        sg_event_id: "sg-click-event-id-fake-0001",
        sg_message_id: "14c5d75ce93.dfd.64b469.filter0001.16648.5515E0B88.0",
        useragent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)",
        ip: "198.51.100.23",
        url: "https://example.com/welcome",
        url_offset: { index: 0, type: "html" },
      },
    ],
    docsUrl: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "sendgrid",
    providerLabel: "SendGrid",
    eventType: "bounce",
    name: "Email bounced",
    description:
      "The receiving server permanently rejected the message. `reason` and `status` carry the SMTP diagnostic.",
    body: [
      {
        email: "unknown@example.com",
        timestamp: 1752564600,
        "smtp-id": "<14c5d75ce93.dfd.64b470@ismtpd-555>",
        bounce_classification: "Invalid Address",
        event: "bounce",
        category: ["welcome-series"],
        sg_event_id: "6g4ZI7SA-xmRDv57GoPIPw_fake==",
        sg_message_id: "14c5d75ce93.dfd.64b470.filter0001.16648.5515E0B88.0",
        reason: "550 5.1.1 The email account that you tried to reach does not exist",
        status: "5.1.1",
        type: "bounce",
        tls: true,
      },
    ],
    docsUrl: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "sendgrid",
    providerLabel: "SendGrid",
    eventType: "spamreport",
    name: "Marked as spam",
    description: "The recipient reported the message as spam via their mail client.",
    body: [
      {
        email: "jordan@example.com",
        timestamp: 1752565200,
        "smtp-id": "<14c5d75ce93.dfd.64b471@ismtpd-555>",
        event: "spamreport",
        category: ["welcome-series"],
        sg_event_id: "37nvH5QBz858KGVYCM4uOA_fake==",
        sg_message_id: "14c5d75ce93.dfd.64b471.filter0001.16648.5515E0B88.0",
      },
    ],
    docsUrl: "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/event",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
