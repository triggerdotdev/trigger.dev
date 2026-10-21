import { type ProviderRegistryEntry } from "./types.js";

/**
 * Firecrawl signs webhooks with an `X-Firecrawl-Signature` header of the form `sha256=<hex>`: a
 * hex-encoded HMAC-SHA256 of the raw request body, keyed by the account-wide webhook secret from the
 * Advanced tab of the account settings (used as UTF-8). There is no timestamp or delivery id header.
 * The event name rides the top-level `type` field, and the top-level `id` is the job id (shared by
 * every event of one crawl, batch scrape, extract or agent job), so it is not a per-delivery key.
 */
export const entry: ProviderRegistryEntry = {
  id: "firecrawl",
  label: "Firecrawl",
  category: "data",
  docsUrl: "https://docs.firecrawl.dev/webhooks/overview",
  secretProvisioning: "provider",
  eventTypeSource: { from: "body", path: "type" },
  sampleSource: "handauthored",
};
