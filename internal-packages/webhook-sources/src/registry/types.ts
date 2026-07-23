import { type WebhookPresetId } from "@trigger.dev/core/webhooks";
import { type WebhookCategoryId } from "./categories.js";

/**
 * Where a provider's event "type" lives. Drives Hookdeck topic parsing and the console picker grouping.
 * Body-discriminated providers keep the type in the payload (e.g. Stripe `type`); header-discriminated
 * ones carry it in a header (e.g. GitHub `x-github-event`).
 */
export type EventTypeSource = { from: "body"; path: string } | { from: "header"; name: string };

/** Who holds the signing secret: the provider issues it, the integrator sets it, or either. */
export type SecretProvisioning = "provider" | "integrator" | "either";

/** Where a provider's samples come from (see the sourcing pipeline in the plan). */
export type SampleSource = "hookdeck" | "octokit" | "capture" | "handauthored";

/**
 * One registry entry per provider. Adding a provider is one of these plus a source. `preset` is set
 * only when the provider maps to one of our verifier presets (unlocks the round-trip guarantee); a
 * provider without a preset ships sample-only until a custom verifier config is authored.
 */
export type ProviderRegistryEntry = {
  id: string;
  label: string;
  category: WebhookCategoryId;
  icon?: string;
  docsUrl?: string;
  preset?: WebhookPresetId;
  secretProvisioning: SecretProvisioning;
  eventTypeSource: EventTypeSource;
  sampleSource: SampleSource;
};
