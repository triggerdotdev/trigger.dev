import { type SampleRecord } from "../sampleRecord.js";

/**
 * Notion samples. No preset: Notion signs with `X-Notion-Signature: sha256=<hex>`, an HMAC-SHA256 of
 * the raw JSON body keyed by the subscription's `verification_token`. The header name and lack of a
 * `t=`/`v1=` component don't match our stripe, github, svix, square, or discord presets.
 */
export const samples: SampleRecord[] = [
  {
    provider: "notion",
    providerLabel: "Notion",
    eventType: "page.created",
    name: "Page created (in database)",
    description: "A new page was added to a database the integration is subscribed to.",
    body: {
      id: "6b6f6b8a-8e0d-4f2a-9f3d-2a6b1c4e7d9f",
      timestamp: "2026-06-30T14:02:11.000Z",
      workspace_id: "13950b26-c203-4f3b-b97d-93ec06319565",
      workspace_name: "Acme Product",
      subscription_id: "29d75c0d-5546-4414-8459-7b7a92f1fc4b",
      integration_id: "0ef2e755-4912-8096-91c1-00376a88a5ca",
      type: "page.created",
      authors: [{ id: "c7c11cca-1d73-471d-9b6e-bdef51470190", type: "person" }],
      attempt_number: 1,
      entity: { id: "0ef104cd-477e-80e1-8571-cfd10e92339a", type: "page" },
      data: {
        parent: { id: "3d8b9a2c-5e1f-4a6d-8c3b-7e9f2d5a1b6c", type: "database" },
      },
    },
    docsUrl: "https://developers.notion.com/reference/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "notion",
    providerLabel: "Notion",
    eventType: "page.content_updated",
    name: "Page content updated (block added)",
    description:
      "A block was added to a page's content; delivery is aggregated over a short window.",
    body: {
      id: "56c3e00c-4f0c-4566-9676-4b058a50a03d",
      timestamp: "2026-07-01T19:49:36.997Z",
      workspace_id: "13950b26-c203-4f3b-b97d-93ec06319565",
      workspace_name: "Acme Product",
      subscription_id: "29d75c0d-5546-4414-8459-7b7a92f1fc4b",
      integration_id: "0ef2e755-4912-8096-91c1-00376a88a5ca",
      type: "page.content_updated",
      authors: [{ id: "c7c11cca-1d73-471d-9b6e-bdef51470190", type: "person" }],
      attempt_number: 1,
      entity: { id: "0ef104cd-477e-80e1-8571-cfd10e92339a", type: "page" },
      data: {
        updated_blocks: [{ id: "153104cd-477e-80ec-a87d-f7ff0236d35c", type: "block" }],
        parent: { id: "0ef104cd-477e-80e1-8571-cfd10e92339a", type: "page" },
      },
    },
    docsUrl: "https://developers.notion.com/reference/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "notion",
    providerLabel: "Notion",
    eventType: "page.properties_updated",
    name: "Page properties updated (status changed)",
    description: "One or more database properties on a page changed value, e.g. a status field.",
    body: {
      id: "8a4d1c7e-2b5f-4d9a-9e3c-6f0a8b2d5c1e",
      timestamp: "2026-07-02T09:15:47.000Z",
      workspace_id: "13950b26-c203-4f3b-b97d-93ec06319565",
      workspace_name: "Acme Product",
      subscription_id: "29d75c0d-5546-4414-8459-7b7a92f1fc4b",
      integration_id: "0ef2e755-4912-8096-91c1-00376a88a5ca",
      type: "page.properties_updated",
      authors: [{ id: "c7c11cca-1d73-471d-9b6e-bdef51470190", type: "person" }],
      attempt_number: 1,
      entity: { id: "5e1f9a3c-6d2b-4f8e-8a1c-3b6d9f2e5a8c", type: "page" },
      data: {
        parent: { id: "3d8b9a2c-5e1f-4a6d-8c3b-7e9f2d5a1b6c", type: "database" },
        updated_properties: ["a1b2%3Ac4d5", "Status"],
      },
    },
    docsUrl: "https://developers.notion.com/reference/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "notion",
    providerLabel: "Notion",
    eventType: "database.content_updated",
    name: "Database content updated",
    description:
      "A page belonging to the database changed. Deprecated in favor of data_source.content_updated as of Notion API version 2025-09-03, but still emitted for integrations pinned to older versions.",
    body: {
      id: "2f5a8d1c-7e3b-4a6f-9c2d-8b1e5a3f7c9d",
      timestamp: "2026-07-03T11:32:05.000Z",
      workspace_id: "13950b26-c203-4f3b-b97d-93ec06319565",
      workspace_name: "Acme Product",
      subscription_id: "29d75c0d-5546-4414-8459-7b7a92f1fc4b",
      integration_id: "0ef2e755-4912-8096-91c1-00376a88a5ca",
      type: "database.content_updated",
      authors: [{ id: "c7c11cca-1d73-471d-9b6e-bdef51470190", type: "person" }],
      attempt_number: 1,
      entity: { id: "3d8b9a2c-5e1f-4a6d-8c3b-7e9f2d5a1b6c", type: "database" },
      data: {
        updated_blocks: [{ id: "9f2d5a8c-1e6b-4d3f-9a7c-2b5e8d1f4a6c", type: "block" }],
        parent: { id: "7c1e4b9d-2a6f-4e8c-9d3b-5f1a8c2e6d9b", type: "workspace" },
      },
    },
    docsUrl: "https://developers.notion.com/reference/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "notion",
    providerLabel: "Notion",
    eventType: "comment.created",
    name: "Comment created (on a page)",
    description:
      "A new top-level comment was added to a page; requires the integration's comment-read capability.",
    body: {
      id: "4b7e1a9d-6c3f-4e8b-8a2d-9f1c5b7e3a6d",
      timestamp: "2026-07-05T16:20:59.000Z",
      workspace_id: "13950b26-c203-4f3b-b97d-93ec06319565",
      workspace_name: "Acme Product",
      subscription_id: "29d75c0d-5546-4414-8459-7b7a92f1fc4b",
      integration_id: "0ef2e755-4912-8096-91c1-00376a88a5ca",
      type: "comment.created",
      authors: [{ id: "1e6b9c3f-8d2a-4c7e-9b1d-6a3f8c2e5d9b", type: "person" }],
      attempt_number: 1,
      entity: { id: "6d9c2a5e-7f1b-4a3d-9e6c-2b5f8a1d4c7e", type: "comment" },
      data: {
        page_id: "0ef104cd-477e-80e1-8571-cfd10e92339a",
        parent: { id: "0ef104cd-477e-80e1-8571-cfd10e92339a", type: "page" },
      },
    },
    docsUrl: "https://developers.notion.com/reference/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
