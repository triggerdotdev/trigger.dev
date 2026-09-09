import { WEBHOOK_PRESET_IDS } from "@trigger.dev/core/webhooks";
import { z } from "zod";

/**
 * Where a sample body came from. `snapshotDate` (YYYY-MM) drives a staleness flag; `upstream` samples
 * are ingested from a maintained source (their `ref` names it), `captured`/`handauthored` otherwise.
 */
export const SampleProvenance = z.object({
  kind: z.enum(["upstream", "captured", "handauthored"]),
  ref: z.string().optional(),
  snapshotDate: z.string().optional(),
});
export type SampleProvenance = z.infer<typeof SampleProvenance>;

/**
 * A single provider sample: the event BODY (plus any non-signature routing header). `provider` is a
 * freeform id (e.g. "shopify"); `presetId` is set only when the provider maps to one of our verifier
 * presets, which unlocks the sign/verify round-trip guarantee. The composer signs the body with the
 * endpoint's own config at send time, so the signature is never stored per-sample.
 */
export const SampleRecord = z.object({
  provider: z.string(),
  providerLabel: z.string().optional(),
  presetId: z.enum(WEBHOOK_PRESET_IDS).optional(),
  eventType: z.string(),
  name: z.string(),
  description: z.string().optional(),
  body: z.unknown(),
  extraHeaders: z.record(z.string(), z.string()).optional(),
  docsUrl: z.string().optional(),
  provenance: SampleProvenance,
});
export type SampleRecord = z.infer<typeof SampleRecord>;

/** The picker metadata (no body), for listing providers + event types. */
export type SampleManifestItem = Omit<SampleRecord, "body" | "extraHeaders">;
