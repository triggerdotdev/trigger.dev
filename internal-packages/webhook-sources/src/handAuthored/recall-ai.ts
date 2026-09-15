import { type SampleRecord } from "../sampleRecord.js";

/**
 * Recall.ai samples. Bot and recording/transcript artifact webhooks share one envelope shape
 * `{ event, data: { data: { code, sub_code, updated_at }, ...refs } }`. Recall.ai signs with Svix, so
 * `presetId: "svix"` keeps them under the round-trip guarantee.
 */
export const samples: SampleRecord[] = [
  {
    provider: "recall-ai",
    providerLabel: "Recall.ai",
    presetId: "svix",
    eventType: "bot.status_change",
    name: "Bot recording",
    description: "A meeting bot has joined the call and started recording.",
    body: {
      event: "bot.status_change",
      data: {
        data: {
          code: "in_call_recording",
          sub_code: null,
          updated_at: "2026-07-14T18:22:03.104Z",
        },
        bot: {
          id: "6f2b1a3e-9c4d-4b7a-8e2f-1d5c9a7b3e21",
          metadata: {},
        },
      },
    },
    docsUrl: "https://docs.recall.ai/docs/bot-status-change-events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "recall-ai",
    providerLabel: "Recall.ai",
    presetId: "svix",
    eventType: "bot.status_change",
    name: "Bot call ended by host",
    description: "The meeting host ended the call, so the bot's call has ended.",
    body: {
      event: "bot.status_change",
      data: {
        data: {
          code: "call_ended",
          sub_code: "call_ended_by_host",
          updated_at: "2026-07-14T18:47:11.882Z",
        },
        bot: {
          id: "6f2b1a3e-9c4d-4b7a-8e2f-1d5c9a7b3e21",
          metadata: {},
        },
      },
    },
    docsUrl: "https://docs.recall.ai/docs/bot-status-change-events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "recall-ai",
    providerLabel: "Recall.ai",
    presetId: "svix",
    eventType: "bot.status_change",
    name: "Bot fatal error",
    description: "The bot ran into an unexpected, unrecoverable error before it could join.",
    body: {
      event: "bot.status_change",
      data: {
        data: {
          code: "fatal",
          sub_code: "bot_errored",
          updated_at: "2026-07-14T18:15:47.221Z",
        },
        bot: {
          id: "a184e6d7-2f3b-4c9e-8a11-6b2d9f4e7c30",
          metadata: {},
        },
      },
    },
    docsUrl: "https://docs.recall.ai/docs/sub-codes",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "recall-ai",
    providerLabel: "Recall.ai",
    presetId: "svix",
    eventType: "recording.done",
    name: "Recording done",
    description: "A bot's recording finished processing and is ready to fetch.",
    body: {
      event: "recording.done",
      data: {
        data: {
          code: "done",
          sub_code: null,
          updated_at: "2026-07-14T18:47:22.556Z",
        },
        recording: {
          id: "3d9e6a2f-7b4c-4e1a-9f8d-2c5b8e1a4d67",
          metadata: {},
        },
        bot: {
          id: "6f2b1a3e-9c4d-4b7a-8e2f-1d5c9a7b3e21",
          metadata: {},
        },
      },
    },
    docsUrl: "https://docs.recall.ai/docs/recording-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "recall-ai",
    providerLabel: "Recall.ai",
    presetId: "svix",
    eventType: "transcript.done",
    name: "Transcript done",
    description: "A bot's transcript finished processing and is ready to fetch.",
    body: {
      event: "transcript.done",
      data: {
        data: {
          code: "done",
          sub_code: null,
          updated_at: "2026-07-14T18:47:45.913Z",
        },
        transcript: {
          id: "9b3f5e7c-1a2d-4c8e-b6f9-3e7d1c9a5b42",
          metadata: {},
        },
        recording: {
          id: "3d9e6a2f-7b4c-4e1a-9f8d-2c5b8e1a4d67",
          metadata: {},
        },
        bot: {
          id: "6f2b1a3e-9c4d-4b7a-8e2f-1d5c9a7b3e21",
          metadata: {},
        },
      },
    },
    docsUrl: "https://docs.recall.ai/docs/bot-async-transcription",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
