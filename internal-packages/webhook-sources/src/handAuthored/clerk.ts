import { type SampleRecord } from "../sampleRecord.js";

/**
 * Clerk samples. Clerk signs webhooks with Svix, so `presetId: "svix"` keeps them under the round-trip
 * guarantee while carrying their own freeform `provider`/`providerLabel`.
 */
export const samples: SampleRecord[] = [
  {
    provider: "clerk",
    providerLabel: "Clerk",
    presetId: "svix",
    eventType: "user.created",
    name: "User created",
    description: "A new Clerk user. Clerk signs webhooks with Svix.",
    body: {
      type: "user.created",
      object: "event",
      data: {
        id: "user_29w83sxmDNGwOuEthce5gg56FcC",
        object: "user",
        first_name: "Jordan",
        last_name: "Lee",
        email_addresses: [
          {
            id: "idn_29w83yL7CwVlJXylYLxcslromF1",
            object: "email_address",
            email_address: "jordan@example.com",
            verification: { status: "verified", strategy: "email_code" },
          },
        ],
        primary_email_address_id: "idn_29w83yL7CwVlJXylYLxcslromF1",
        created_at: 1654012591514,
        updated_at: 1654012591835,
      },
    },
    docsUrl: "https://clerk.com/docs/integrations/webhooks/overview",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
