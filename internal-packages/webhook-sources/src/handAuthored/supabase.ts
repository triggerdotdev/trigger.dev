import { type SampleRecord } from "../sampleRecord.js";

/**
 * Supabase Database Webhook samples. Supabase has no built-in signing scheme (verification is
 * whatever custom header the integrator wires into the underlying `net.http_post` trigger), so no
 * `presetId` is set on any sample here. `eventType` is the body's top-level `type` field
 * (`INSERT` / `UPDATE` / `DELETE`); `record` holds the new row and `old_record` the previous row,
 * with one or the other `null` depending on the operation.
 */
export const samples: SampleRecord[] = [
  {
    provider: "supabase",
    providerLabel: "Supabase",
    eventType: "INSERT",
    name: "Order created",
    description: "A new row was inserted into the public.orders table.",
    body: {
      type: "INSERT",
      table: "orders",
      schema: "public",
      record: {
        id: 4821,
        customer_id: "b1a2c3d4-5e6f-47a8-9b0c-1d2e3f4a5b6c",
        status: "pending",
        total_cents: 8999,
        currency: "usd",
        created_at: "2026-07-14T18:22:03.511Z",
        updated_at: "2026-07-14T18:22:03.511Z",
      },
      old_record: null,
    },
    docsUrl: "https://supabase.com/docs/guides/database/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "supabase",
    providerLabel: "Supabase",
    eventType: "UPDATE",
    name: "Order status updated",
    description:
      "An existing public.orders row moved from pending to shipped. `old_record` requires REPLICA IDENTITY FULL on the table, otherwise it is null.",
    body: {
      type: "UPDATE",
      table: "orders",
      schema: "public",
      record: {
        id: 4821,
        customer_id: "b1a2c3d4-5e6f-47a8-9b0c-1d2e3f4a5b6c",
        status: "shipped",
        total_cents: 8999,
        currency: "usd",
        created_at: "2026-07-14T18:22:03.511Z",
        updated_at: "2026-07-15T09:41:27.204Z",
      },
      old_record: {
        id: 4821,
        customer_id: "b1a2c3d4-5e6f-47a8-9b0c-1d2e3f4a5b6c",
        status: "pending",
        total_cents: 8999,
        currency: "usd",
        created_at: "2026-07-14T18:22:03.511Z",
        updated_at: "2026-07-14T18:22:03.511Z",
      },
    },
    docsUrl: "https://supabase.com/docs/guides/database/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "supabase",
    providerLabel: "Supabase",
    eventType: "DELETE",
    name: "Order deleted",
    description:
      "A public.orders row was deleted; `record` is null and `old_record` is the removed row.",
    body: {
      type: "DELETE",
      table: "orders",
      schema: "public",
      record: null,
      old_record: {
        id: 4790,
        customer_id: "f3e2d1c0-8b7a-4693-8c5d-2a1b0c9d8e7f",
        status: "cancelled",
        total_cents: 4500,
        currency: "usd",
        created_at: "2026-07-11T12:05:44.883Z",
        updated_at: "2026-07-13T07:18:52.036Z",
      },
    },
    docsUrl: "https://supabase.com/docs/guides/database/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "supabase",
    providerLabel: "Supabase",
    eventType: "INSERT",
    name: "Profile created",
    description:
      "A new row was inserted into public.profiles, a common pattern for mirroring auth.users signups into an app-owned table.",
    body: {
      type: "INSERT",
      table: "profiles",
      schema: "public",
      record: {
        id: "c7d8e9f0-1a2b-43c4-8d5e-6f7a8b9c0d1e",
        username: "jordan_lee",
        full_name: "Jordan Lee",
        avatar_url:
          "https://xyzcompany.supabase.co/storage/v1/object/public/avatars/jordan_lee.png",
        created_at: "2026-07-15T08:03:11.902Z",
      },
      old_record: null,
    },
    docsUrl: "https://supabase.com/docs/guides/database/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "supabase",
    providerLabel: "Supabase",
    eventType: "UPDATE",
    name: "Profile updated",
    description: "A public.profiles row changed its username.",
    body: {
      type: "UPDATE",
      table: "profiles",
      schema: "public",
      record: {
        id: "c7d8e9f0-1a2b-43c4-8d5e-6f7a8b9c0d1e",
        username: "jordan.lee",
        full_name: "Jordan Lee",
        avatar_url:
          "https://xyzcompany.supabase.co/storage/v1/object/public/avatars/jordan_lee.png",
        created_at: "2026-07-15T08:03:11.902Z",
      },
      old_record: {
        id: "c7d8e9f0-1a2b-43c4-8d5e-6f7a8b9c0d1e",
        username: "jordan_lee",
        full_name: "Jordan Lee",
        avatar_url:
          "https://xyzcompany.supabase.co/storage/v1/object/public/avatars/jordan_lee.png",
        created_at: "2026-07-15T08:03:11.902Z",
      },
    },
    docsUrl: "https://supabase.com/docs/guides/database/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
