import { type SampleRecord } from "../sampleRecord.js";

/**
 * AssemblyAI transcript webhooks. The documented payload is intentionally minimal - just
 * `transcript_id` and `status` - with only two possible `status` values (`completed`, `error`). Auth
 * is a static shared secret header (`webhook_auth_header_name`/`webhook_auth_header_value`, set by the
 * integrator when creating the transcript), not an HMAC/Ed25519 signature, so these ship sample-only
 * (no `presetId`).
 */
export const samples: SampleRecord[] = [
  {
    provider: "assemblyai",
    providerLabel: "AssemblyAI",
    eventType: "completed",
    name: "Transcript completed",
    description:
      "The transcription finished successfully. Fetch GET /v2/transcript/{transcript_id} to retrieve the text.",
    body: {
      transcript_id: "5552493-16d8-42d8-8feb-c2a16b56f6e8",
      status: "completed",
    },
    docsUrl: "https://www.assemblyai.com/docs/concepts/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "assemblyai",
    providerLabel: "AssemblyAI",
    eventType: "error",
    name: "Transcript error",
    description:
      "The transcription failed. Fetch GET /v2/transcript/{transcript_id} to read the `error` field with the failure reason.",
    body: {
      transcript_id: "8317204-9a2c-4f11-b6d0-1e6c4a8f7c3d",
      status: "error",
    },
    docsUrl: "https://www.assemblyai.com/docs/concepts/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
