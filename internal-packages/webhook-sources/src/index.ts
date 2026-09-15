import { type SampleManifestItem, type SampleRecord } from "./sampleRecord.js";
import { samples } from "./samples.js";

export { SampleProvenance, SampleRecord } from "./sampleRecord.js";
export type { SampleManifestItem } from "./sampleRecord.js";
export { samples } from "./samples.js";
export { registry, registryEntries, getProvider } from "./registry/index.js";
export type {
  ProviderRegistryEntry,
  EventTypeSource,
  SecretProvisioning,
  SampleSource,
} from "./registry/types.js";
export { WEBHOOK_CATEGORIES, categoryLabel, categoryOrder } from "./registry/categories.js";
export type { WebhookCategoryId } from "./registry/categories.js";

/** Picker metadata (no bodies), small enough to ship to the client in one response. */
export function sampleManifest(): SampleManifestItem[] {
  return samples.map(({ body, extraHeaders, ...meta }) => meta);
}

/** A single sample's full record (with body + headers), looked up on selection. */
export function getSample(provider: string, eventType: string): SampleRecord | undefined {
  return samples.find((sample) => sample.provider === provider && sample.eventType === eventType);
}
