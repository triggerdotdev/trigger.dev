import { type ProviderRegistryEntry } from "./types.js";

/**
 * Supabase Database Webhooks have no built-in signing scheme - the docs describe only the payload
 * shape (`type`/`table`/`schema`/`record`/`old_record`), and any authentication is whatever custom
 * HTTP header the integrator adds to the underlying `net.http_post` call (e.g. a bearer token or a
 * shared-secret header they check for themselves). That doesn't match any of our verifier presets, so
 * this ships sample-only with no preset. The event discriminant is the top-level `type` field, one of
 * `INSERT` / `UPDATE` / `DELETE`.
 */
export const entry: ProviderRegistryEntry = {
  id: "supabase",
  label: "Supabase",
  category: "hosting-infra",
  docsUrl: "https://supabase.com/docs/guides/database/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
