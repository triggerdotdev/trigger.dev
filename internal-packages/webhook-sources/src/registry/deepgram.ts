import { type ProviderRegistryEntry } from "./types.js";

/**
 * Deepgram's async transcription callback carries a `dg-token` header set to the API Key Identifier
 * that submitted the original request - an identifier, not an HMAC/Ed25519 signature - so no preset
 * applies. Protecting the endpoint is left to the integrator (embed Basic Auth credentials in the
 * callback URL itself, or IP-allowlist Deepgram's senders); Deepgram never issues a per-endpoint secret.
 * The callback body is the raw transcription result object (metadata + results), with no discriminant
 * field at all. `results.channels` is present only on success; a failed job instead delivers
 * `{ err_code, err_msg, request_id }` (Deepgram's general API error shape). `eventTypeSource` points at
 * `results.channels` as the representative success case; each sample's explicit `eventType` is
 * authoritative.
 */
export const entry: ProviderRegistryEntry = {
  id: "deepgram",
  label: "Deepgram",
  category: "ai-platform",
  docsUrl: "https://developers.deepgram.com/docs/callback",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "results.channels" },
  sampleSource: "handauthored",
};
