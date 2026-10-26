import { type SampleRecord } from "../sampleRecord.js";

/**
 * Loops samples. Loops signs webhooks with Standard Webhooks (`webhook-id`/`webhook-timestamp`/
 * `webhook-signature`, `whsec_` secret), so `presetId: "standard-webhooks"` keeps them under the
 * round-trip guarantee. Every body carries `eventName`, `eventTime` (Unix seconds) and
 * `webhookSchemaVersion: "1.0.0"`, plus `contactIdentity`. Email events add `sourceType` (`campaign`,
 * `loop` or `transactional`) and the matching `campaignId`/`loopId`/`transactionalId`. Workflows still
 * use `loop` names in payloads.
 */
export const samples: SampleRecord[] = [
  {
    provider: "loops",
    providerLabel: "Loops",
    presetId: "standard-webhooks",
    eventType: "contact.created",
    name: "Contact created",
    description: "A new contact was added to the audience, with its full properties.",
    body: {
      eventName: "contact.created",
      eventTime: 1791972143,
      webhookSchemaVersion: "1.0.0",
      contactIdentity: {
        id: "cmg7k2p4x0003qz8hf2d1a9wt",
        email: "jamie@example.com",
        userId: "usr_8f3a2c71",
      },
      contact: {
        id: "cmg7k2p4x0003qz8hf2d1a9wt",
        email: "jamie@example.com",
        firstName: "Jamie",
        lastName: "Rivera",
        source: "API",
        subscribed: true,
        userGroup: "trial",
        userId: "usr_8f3a2c71",
        mailingLists: {
          cmg7k1x9q000l4r2tbn6yv3pe: true,
        },
        optInStatus: null,
        plan: "starter",
        signupCount: 1,
      },
    },
    docsUrl: "https://loops.so/docs/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "loops",
    providerLabel: "Loops",
    presetId: "standard-webhooks",
    eventType: "contact.mailingList.subscribed",
    name: "Contact subscribed to mailing list",
    description: "A contact was subscribed to a mailing list.",
    body: {
      eventName: "contact.mailingList.subscribed",
      eventTime: 1791972410,
      webhookSchemaVersion: "1.0.0",
      contactIdentity: {
        id: "cmg7k2p4x0003qz8hf2d1a9wt",
        email: "jamie@example.com",
        userId: "usr_8f3a2c71",
      },
      mailingList: {
        id: "cmg7k1x9q000l4r2tbn6yv3pe",
        name: "Product updates",
        description: "Monthly changelog and release notes",
        isPublic: true,
      },
    },
    docsUrl: "https://loops.so/docs/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "loops",
    providerLabel: "Loops",
    presetId: "standard-webhooks",
    eventType: "transactional.email.sent",
    name: "Transactional email sent",
    description: "A transactional email was sent to a contact.",
    body: {
      eventName: "transactional.email.sent",
      eventTime: 1791973025,
      webhookSchemaVersion: "1.0.0",
      contactIdentity: {
        id: "cmg8a4r7d0011wz3kp5c2m8qh",
        email: "morgan@example.com",
        userId: null,
      },
      transactionalId: "cmg6z9t2b001uq7mxr4e8k1vd",
      transactionalName: "Password reset",
      email: {
        id: "cmg8a4s1f004tje79n2w6b8xc",
        emailMessageId: "cmg6z9t5h001wq7mxd3r9p2ya",
        subject: "Reset your Acme password",
      },
    },
    docsUrl: "https://loops.so/docs/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "loops",
    providerLabel: "Loops",
    presetId: "standard-webhooks",
    eventType: "email.delivered",
    name: "Email delivered",
    description: "A campaign email was delivered to its recipient.",
    body: {
      eventName: "email.delivered",
      eventTime: 1791980467,
      webhookSchemaVersion: "1.0.0",
      sourceType: "campaign",
      campaignId: "cmg9b2k6n001uw6atq7z3x5rf",
      email: {
        id: "cmg9b2l0p004yje79h4t8c1mv",
        emailMessageId: "cmg9b2k6n001ww6atk2d7s9qb",
        subject: "What's new in October",
      },
      contactIdentity: {
        id: "cmg7k2p4x0003qz8hf2d1a9wt",
        email: "jamie@example.com",
        userId: "usr_8f3a2c71",
      },
    },
    docsUrl: "https://loops.so/docs/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "loops",
    providerLabel: "Loops",
    presetId: "standard-webhooks",
    eventType: "email.hardBounced",
    name: "Email hard bounced",
    description:
      "A workflow email hard bounced; Loops also unsubscribes the contact and sends contact.unsubscribed.",
    body: {
      eventName: "email.hardBounced",
      eventTime: 1791984102,
      webhookSchemaVersion: "1.0.0",
      sourceType: "loop",
      loopId: "cmg5w8e3j0052icemh6p1t4zn",
      email: {
        id: "cmg9c7m2q004mje79r5v1k8sd",
        emailMessageId: "cmg5w8e9u001oow9hx3b6n2lf",
        subject: "Finish setting up your workspace",
      },
      contactIdentity: {
        id: "cmg9c6z1w0014ow9hd8q3r7ka",
        email: "taylor@example.org",
        userId: null,
      },
    },
    docsUrl: "https://loops.so/docs/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "loops",
    providerLabel: "Loops",
    presetId: "standard-webhooks",
    eventType: "email.clicked",
    name: "Email link clicked",
    description: "A recipient clicked a link in a campaign email.",
    body: {
      eventName: "email.clicked",
      eventTime: 1791988735,
      webhookSchemaVersion: "1.0.0",
      sourceType: "campaign",
      campaignId: "cmg9b2k6n001uw6atq7z3x5rf",
      email: {
        id: "cmg9b2l0p004yje79h4t8c1mv",
        emailMessageId: "cmg9b2k6n001ww6atk2d7s9qb",
        subject: "What's new in October",
      },
      contactIdentity: {
        id: "cmg7k2p4x0003qz8hf2d1a9wt",
        email: "jamie@example.com",
        userId: "usr_8f3a2c71",
      },
    },
    docsUrl: "https://loops.so/docs/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];
