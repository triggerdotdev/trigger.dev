import { type SampleRecord } from "../sampleRecord.js";

/**
 * Discord Webhook Events samples. Every delivery (including the initial `PING` handshake) shares
 * the outer envelope `{ version, application_id, type, event? }`; `type: 0` is the PING handshake
 * with no `event` field, `type: 1` carries `event: { type, timestamp, data }`. `QUEST_USER_ENROLLMENT`
 * is documented but explicitly marked as not currently deliverable to apps, so it is excluded here.
 */
export const samples: SampleRecord[] = [
  {
    provider: "discord",
    providerLabel: "Discord",
    presetId: "discord",
    eventType: "PING",
    name: "Webhook handshake PING",
    description:
      "Sent once when you save a webhook events URL in the developer portal, to confirm you can verify and respond in time.",
    body: {
      version: 1,
      application_id: "1102345678901234567",
      type: 0,
    },
    docsUrl: "https://docs.discord.com/developers/events/webhook-events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "discord",
    providerLabel: "Discord",
    presetId: "discord",
    eventType: "APPLICATION_AUTHORIZED",
    name: "App authorized to a server",
    description: "A user installed and authorized the app to a guild (server).",
    body: {
      version: 1,
      application_id: "1102345678901234567",
      type: 1,
      event: {
        type: "APPLICATION_AUTHORIZED",
        timestamp: "2026-07-14T18:22:03.064834",
        data: {
          integration_type: 0,
          scopes: ["applications.commands", "bot"],
          user: {
            id: "912233445566778899",
            username: "quinn.dev",
            discriminator: "0",
            avatar: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
            global_name: "Quinn",
          },
          guild: {
            id: "445566778899001122",
            name: "Trigger.dev Community",
            icon: "f2e1d0c9b8a7968574635241302f1e0d",
          },
        },
      },
    },
    docsUrl: "https://docs.discord.com/developers/events/webhook-events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "discord",
    providerLabel: "Discord",
    presetId: "discord",
    eventType: "APPLICATION_DEAUTHORIZED",
    name: "App deauthorized by a user",
    description:
      "A user removed the app's authorization (uninstalled it from their account or a server).",
    body: {
      version: 1,
      application_id: "1102345678901234567",
      type: 1,
      event: {
        type: "APPLICATION_DEAUTHORIZED",
        timestamp: "2026-07-14T19:05:41.221009",
        data: {
          user: {
            id: "912233445566778899",
            username: "quinn.dev",
            discriminator: "0",
            avatar: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
            global_name: "Quinn",
          },
        },
      },
    },
    docsUrl: "https://docs.discord.com/developers/events/webhook-events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "discord",
    providerLabel: "Discord",
    presetId: "discord",
    eventType: "ENTITLEMENT_CREATE",
    name: "Premium entitlement created",
    description: "A user purchased or was granted an application subscription entitlement.",
    body: {
      version: 1,
      application_id: "1102345678901234567",
      type: 1,
      event: {
        type: "ENTITLEMENT_CREATE",
        timestamp: "2026-07-14T20:11:09.109604",
        data: {
          id: "1201983746501928374",
          application_id: "1102345678901234567",
          sku_id: "1091827364501928374",
          user_id: "912233445566778899",
          type: 8,
          deleted: false,
          consumed: false,
          gift_code_flags: 0,
          promotion_id: null,
        },
      },
    },
    docsUrl: "https://docs.discord.com/developers/events/webhook-events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "discord",
    providerLabel: "Discord",
    presetId: "discord",
    eventType: "ENTITLEMENT_DELETE",
    name: "Premium entitlement revoked",
    description: "An entitlement was deleted, typically because of a refund or chargeback.",
    body: {
      version: 1,
      application_id: "1102345678901234567",
      type: 1,
      event: {
        type: "ENTITLEMENT_DELETE",
        timestamp: "2026-07-14T21:47:33.552817",
        data: {
          id: "1201983746501928374",
          application_id: "1102345678901234567",
          sku_id: "1091827364501928374",
          user_id: "912233445566778899",
          type: 8,
          deleted: true,
          consumed: false,
          gift_code_flags: 0,
          promotion_id: null,
        },
      },
    },
    docsUrl: "https://docs.discord.com/developers/events/webhook-events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
