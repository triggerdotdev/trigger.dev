import generated from "./generated/hookdeck-samples.json";
import { handAuthoredSamples } from "./handAuthored/index.js";
import { type SampleRecord } from "./sampleRecord.js";

/**
 * The provider samples: the vendored Hookdeck ingest (MIT, see NOTICE.md; regenerate with
 * `pnpm run ingest`) merged with the hand-authored set, sorted by provider then event type.
 */
export const samples: SampleRecord[] = [
  ...(generated as unknown as SampleRecord[]),
  ...handAuthoredSamples,
].sort((a, b) =>
  a.provider === b.provider
    ? a.eventType.localeCompare(b.eventType)
    : a.provider.localeCompare(b.provider)
);
