import { type SampleRecord } from "../sampleRecord.js";

/**
 * Granola samples. Granola signs webhooks with Standard Webhooks (`webhook-id`/`webhook-timestamp`/
 * `webhook-signature`, `whsec_` secret), so `presetId: "standard-webhooks"` keeps them under the
 * round-trip guarantee. Payloads are deliberately small and carry no note content: `event_id`,
 * `event_type`, `note_id` and `occurred_at` (ISO 8601), plus `data.changed_fields` on `note.edited`.
 * Receivers fetch the note itself with the Get Note API. Granola documents only these three events.
 */
export const samples: SampleRecord[] = [
  {
    provider: "granola",
    providerLabel: "Granola",
    presetId: "standard-webhooks",
    eventType: "note.generated",
    name: "Note generated",
    description: "The first AI summary for a meeting note was generated.",
    body: {
      event_id: "3b7e9c21-5a4d-4f8e-b1c6-9d2a7e4f0c58",
      event_type: "note.generated",
      note_id: "not_4kTq8ZwRmN2vXp",
      occurred_at: "2026-10-14T16:02:11Z",
    },
    docsUrl: "https://docs.granola.ai/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "granola",
    providerLabel: "Granola",
    presetId: "standard-webhooks",
    eventType: "note.edited",
    name: "Note edited",
    description: "A note's summary was edited or regenerated.",
    body: {
      event_id: "c4a18f6e-2d9b-4e37-8a5c-1f6b3d9e7a24",
      event_type: "note.edited",
      note_id: "not_4kTq8ZwRmN2vXp",
      occurred_at: "2026-10-14T16:27:45Z",
      data: {
        changed_fields: ["summary"],
      },
    },
    docsUrl: "https://docs.granola.ai/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
  {
    provider: "granola",
    providerLabel: "Granola",
    presetId: "standard-webhooks",
    eventType: "note.access_granted",
    name: "Note access granted",
    description:
      "An already generated note was shared with the endpoint, directly or via a folder.",
    body: {
      event_id: "7f2d5b83-9e1a-4c6f-a8d4-2b5e8c1f9a36",
      event_type: "note.access_granted",
      note_id: "not_9hLp3YcVsB6tQe",
      occurred_at: "2026-10-15T09:14:03Z",
    },
    docsUrl: "https://docs.granola.ai/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-10" },
  },
];
