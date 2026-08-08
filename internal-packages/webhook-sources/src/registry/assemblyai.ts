import { type ProviderRegistryEntry } from "./types.js";

/**
 * AssemblyAI authenticates webhooks with a static shared secret: the integrator supplies
 * `webhook_auth_header_name` / `webhook_auth_header_value` when creating the transcript, and
 * AssemblyAI echoes that header back verbatim on delivery. There is no HMAC or Ed25519 signature, so
 * no preset applies. The payload only ever carries `transcript_id` and `status` (`completed` or
 * `error`) - callers must GET `/v2/transcript/{id}` separately for the transcript text or error detail.
 */
export const entry: ProviderRegistryEntry = {
  id: "assemblyai",
  label: "AssemblyAI",
  category: "ai-platform",
  docsUrl: "https://www.assemblyai.com/docs/concepts/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "status" },
  sampleSource: "handauthored",
};
