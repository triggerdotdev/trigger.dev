import { type ProviderRegistryEntry } from "./types.js";

/**
 * Supabase Database Webhooks have no built-in signing scheme: the docs describe only the payload
 * shape (`type`/`table`/`schema`/`record`/`old_record`), and any authentication is whatever custom
 * HTTP header the integrator adds to the webhook (or the underlying `net.http_post` call). The
 * `supabase` provider config in core checks a shared secret sent as `Authorization: Bearer <secret>`,
 * which the integrator generates on Trigger.dev and adds under the webhook's HTTP Headers. It
 * authenticates the sender but does not sign the body. The event discriminant is the top-level `type`
 * field, one of `INSERT` / `UPDATE` / `DELETE`.
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
