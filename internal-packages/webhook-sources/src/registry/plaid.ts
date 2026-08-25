import { type ProviderRegistryEntry } from "./types.js";

/**
 * Plaid signs webhooks with a `Plaid-Verification` header carrying a JWT (ES256: ECDSA over
 * SHA-256), whose payload holds `iat` and a `request_body_sha256` hash of the raw body; the
 * receiver fetches the signing JWK from `/webhook_verification_key/get` by the JWT's `kid`. This
 * is a bespoke JWS + separate-key-fetch scheme, not a shared-secret HMAC, so it does not match any
 * of stripe/github/svix/square/discord - ships sample-only with no preset. `secretProvisioning` is
 * "provider" because Plaid alone holds the signing key; there is no integrator-set secret. The
 * discriminant is the top-level `webhook_type` (TRANSACTIONS, ITEM, ...); the finer-grained event
 * also depends on `webhook_code` (and, for ITEM ERROR, the nested `error.error_code`).
 */
export const entry: ProviderRegistryEntry = {
  id: "plaid",
  label: "Plaid",
  category: "fintech",
  docsUrl: "https://plaid.com/docs/api/webhooks/webhook-verification/",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "webhook_type" },
  sampleSource: "handauthored",
};
