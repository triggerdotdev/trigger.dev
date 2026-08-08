import { type SampleRecord } from "../sampleRecord.js";

/**
 * Attio samples. No preset: Attio signs with its own `attio-signature` header, a bare hex
 * HMAC-SHA256 digest of the raw body (no `sha256=` prefix, no timestamp), which doesn't match
 * stripe, github, svix, square, or discord. Each delivery wraps one event in a `webhook_id` +
 * `events` envelope; Attio notes deliveries currently carry exactly one event but may batch more
 * in future, so `events` is modeled as an array per the real shape.
 */
export const samples: SampleRecord[] = [
  {
    provider: "attio",
    providerLabel: "Attio",
    eventType: "record.created",
    name: "Record created (company)",
    description: "A new company record was created in the workspace via the UI.",
    body: {
      webhook_id: "23e42eaf-323a-41da-b5bb-fd67eebda553",
      events: [
        {
          event_type: "record.created",
          id: {
            workspace_id: "14beef7a-99f7-4534-a87e-70b564330a4c",
            object_id: "97052eb9-e65e-443f-a297-f2d9a4a7f795",
            record_id: "bf071e1f-6035-429d-b874-d83ea64ea13b",
          },
          actor: {
            type: "workspace-member",
            id: "50cf242c-7fa3-4cad-87d0-75b1af71c57b",
          },
        },
      ],
    },
    docsUrl: "https://docs.attio.com/rest-api/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "attio",
    providerLabel: "Attio",
    eventType: "record.updated",
    name: "Record updated (stage attribute changed)",
    description: "An existing record's deal-stage attribute was changed by a workspace member.",
    body: {
      webhook_id: "23e42eaf-323a-41da-b5bb-fd67eebda553",
      events: [
        {
          event_type: "record.updated",
          id: {
            workspace_id: "14beef7a-99f7-4534-a87e-70b564330a4c",
            object_id: "6a1f3d9c-8b2e-4c7a-9d5f-2e8b1a4c7d9e",
            record_id: "d4c8b2a6-1e9f-4d3c-8a7b-5f2e9c1d6a8b",
            attribute_id: "41252299-f8c7-4b5e-99c9-4ff8321d2f96",
          },
          actor: {
            type: "workspace-member",
            id: "50cf242c-7fa3-4cad-87d0-75b1af71c57b",
          },
        },
      ],
    },
    docsUrl: "https://docs.attio.com/rest-api/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "attio",
    providerLabel: "Attio",
    eventType: "record.deleted",
    name: "Record deleted (person)",
    description: "A person record was permanently deleted from the workspace.",
    body: {
      webhook_id: "23e42eaf-323a-41da-b5bb-fd67eebda553",
      events: [
        {
          event_type: "record.deleted",
          id: {
            workspace_id: "14beef7a-99f7-4534-a87e-70b564330a4c",
            object_id: "9b3e6f1a-2c8d-4e5b-9f7a-1d4c8e2b6f9a",
            record_id: "2f6b9d4e-8a1c-4f7d-9b3e-6c2a5f8d1b4c",
          },
          actor: {
            type: "workspace-member",
            id: "7d2a9f4c-1b6e-4c8d-9a3f-5e1b8c2d6f9a",
          },
        },
      ],
    },
    docsUrl: "https://docs.attio.com/rest-api/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "attio",
    providerLabel: "Attio",
    eventType: "list-entry.created",
    name: "List entry created (added to sales pipeline)",
    description: "An existing company record was added as an entry to the sales pipeline list.",
    body: {
      webhook_id: "23e42eaf-323a-41da-b5bb-fd67eebda553",
      events: [
        {
          event_type: "list-entry.created",
          id: {
            workspace_id: "14beef7a-99f7-4534-a87e-70b564330a4c",
            list_id: "33ebdbe9-e529-47c9-b894-0ba25e9c15c0",
            entry_id: "2e6e29ea-c4e0-4f44-842d-78a891f8c156",
          },
          parent_object_id: "97052eb9-e65e-443f-a297-f2d9a4a7f795",
          parent_record_id: "bf071e1f-6035-429d-b874-d83ea64ea13b",
          actor: {
            type: "workspace-member",
            id: "50cf242c-7fa3-4cad-87d0-75b1af71c57b",
          },
        },
      ],
    },
    docsUrl: "https://docs.attio.com/rest-api/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "attio",
    providerLabel: "Attio",
    eventType: "note.created",
    name: "Note created (on a company record)",
    description: "A workspace member added a note to an existing company record.",
    body: {
      webhook_id: "23e42eaf-323a-41da-b5bb-fd67eebda553",
      events: [
        {
          event_type: "note.created",
          id: {
            workspace_id: "14beef7a-99f7-4534-a87e-70b564330a4c",
            note_id: "ff3f3bd4-40f4-4f80-8187-cd02385af424",
          },
          parent_object_id: "97052eb9-e65e-443f-a297-f2d9a4a7f795",
          parent_record_id: "bf071e1f-6035-429d-b874-d83ea64ea13b",
          actor: {
            type: "workspace-member",
            id: "50cf242c-7fa3-4cad-87d0-75b1af71c57b",
          },
        },
      ],
    },
    docsUrl: "https://docs.attio.com/rest-api/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
