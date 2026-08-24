import { type SampleRecord } from "../sampleRecord.js";

/**
 * OpenAI samples. OpenAI signs webhooks with Svix, so `presetId: "svix"` keeps them under the
 * round-trip guarantee. Every event is a thin envelope (`id`, `object: "event"`, `created_at`,
 * `type`, `data`) where `data` carries only the resource id (or, for the Realtime SIP event, the
 * call id + SIP headers) - integrators call back the relevant API with that id to fetch full state.
 */
export const samples: SampleRecord[] = [
  {
    provider: "openai",
    providerLabel: "OpenAI",
    presetId: "svix",
    eventType: "batch.completed",
    name: "Batch completed",
    description:
      "An async Batch API job finished successfully. Fetch the batch with `data.id` to get the output file id.",
    body: {
      id: "evt_685343a1381c819085d44c354e1b330e",
      object: "event",
      created_at: 1784065200,
      type: "batch.completed",
      data: {
        id: "batch_67d1e3d640848190a3f3f19c74e9d9de",
      },
    },
    docsUrl: "https://platform.openai.com/docs/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "openai",
    providerLabel: "OpenAI",
    presetId: "svix",
    eventType: "batch.failed",
    name: "Batch failed",
    description:
      "An async Batch API job failed. Fetch the batch with `data.id` for the error file and failure reason.",
    body: {
      id: "evt_5f2c9a7e6d1b4c3a9e0f7d2b8c6a1e4f",
      object: "event",
      created_at: 1784068800,
      type: "batch.failed",
      data: {
        id: "batch_a1b2c3d4e5f647890a1b2c3d4e5f6789",
      },
    },
    docsUrl: "https://platform.openai.com/docs/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "openai",
    providerLabel: "OpenAI",
    presetId: "svix",
    eventType: "fine_tuning.job.succeeded",
    name: "Fine-tuning job succeeded",
    description:
      "A fine-tuning job finished training. Fetch the job with `data.id` to get the fine-tuned model name.",
    body: {
      id: "evt_3d8e1f6a9c2b4d7e0f5a8c1b6d9e2f4a",
      object: "event",
      created_at: 1784072400,
      type: "fine_tuning.job.succeeded",
      data: {
        id: "ftjob-3sPygNaFf0EBAJoATNqFrOca",
      },
    },
    docsUrl: "https://platform.openai.com/docs/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "openai",
    providerLabel: "OpenAI",
    presetId: "svix",
    eventType: "response.completed",
    name: "Response completed",
    description:
      "A background Responses API request finished. Fetch it with `data.id` to get the full output.",
    body: {
      id: "evt_685343a1381c819085d44c354e1b330e",
      object: "event",
      created_at: 1784076000,
      type: "response.completed",
      data: {
        id: "resp_67ccd6a5da548190a97a9ff8b48e1d6c",
      },
    },
    docsUrl: "https://platform.openai.com/docs/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "openai",
    providerLabel: "OpenAI",
    presetId: "svix",
    eventType: "eval.run.succeeded",
    name: "Eval run succeeded",
    description:
      "An Evals API run finished. Fetch it with `data.id` to get result counts and per-model usage.",
    body: {
      id: "evt_9b4d7f2a5c8e1b3d6f9a2c5e8b1d4f7a",
      object: "event",
      created_at: 1784079600,
      type: "eval.run.succeeded",
      data: {
        id: "evalrun_67abd54d60ec8190832b46859da808f7",
      },
    },
    docsUrl: "https://platform.openai.com/docs/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "openai",
    providerLabel: "OpenAI",
    presetId: "svix",
    eventType: "realtime.call.incoming",
    name: "Incoming Realtime SIP call",
    description:
      "A SIP call arrived for the Realtime API. Use `data.call_id` to accept or reject it before it rings out.",
    body: {
      id: "evt_685343a1381c819085d44c354e1b330e",
      object: "event",
      created_at: 1784083200,
      type: "realtime.call.incoming",
      data: {
        call_id: "call_C9RyJt3H0IXXCCUmr1cxoQZ5aB2",
        sip_headers: [
          { name: "From", value: "sip:+14255551212@sip.example.com" },
          { name: "To", value: "sip:+18005551212@sip.example.com" },
          { name: "Call-ID", value: "03782086-4ce9-44bf-8b0d-4e303d2cc590" },
        ],
      },
    },
    docsUrl: "https://platform.openai.com/docs/guides/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
