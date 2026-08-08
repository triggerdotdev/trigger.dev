import { type ProviderRegistryEntry } from "./types.js";

/**
 * Vercel signs webhooks with a bespoke scheme: the `x-vercel-signature` header carries a hex-encoded
 * HMAC-SHA1 digest of the raw body (no `sha1=` prefix, no timestamp component). That doesn't match any
 * of our presets (stripe/github/svix/square/discord all use SHA256 or Ed25519, and github's closest
 * cousin still requires the `sha256=`-prefixed hex plus a `-256` header suffix), so this ships
 * sample-only with no preset. The event name rides the top-level `type` field in the body.
 */
export const entry: ProviderRegistryEntry = {
  id: "vercel",
  label: "Vercel",
  category: "hosting-infra",
  docsUrl: "https://vercel.com/docs/webhooks",
  secretProvisioning: "integrator",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
