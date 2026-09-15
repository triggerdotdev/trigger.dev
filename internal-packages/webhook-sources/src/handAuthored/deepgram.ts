import { type SampleRecord } from "../sampleRecord.js";

/**
 * Deepgram prerecorded-transcription callback samples. When a `callback` URL is supplied to the
 * `/v1/listen` endpoint, Deepgram POSTs the finished job's result to that URL - the same JSON shape
 * the synchronous API would have returned, `{ metadata, results }`, with no `type`/`event` discriminant
 * anywhere in the body. Auth is a `dg-token` header identifying (not authenticating) the API key used;
 * there is no HMAC/Ed25519 signature, so these ship sample-only (no `presetId`). A failed job instead
 * delivers Deepgram's general API error shape, `{ err_code, err_msg, request_id }`. `eventType` here is
 * our own descriptive label (there is no wire value to mirror), distinguishing the shapes an integrator
 * actually needs to branch on: plain mono, multichannel, diarized/utterance-level, and failure.
 */
export const samples: SampleRecord[] = [
  {
    provider: "deepgram",
    providerLabel: "Deepgram",
    eventType: "transcript.completed",
    name: "Transcript completed",
    description:
      "A prerecorded mono transcription job finished. `results.channels[].alternatives[0]` carries the transcript, overall confidence, and per-word timing.",
    body: {
      metadata: {
        transaction_key: "deprecated",
        request_id: "c22bea24-ecd3-4b53-bcbf-8ef087d905a5",
        sha256: "d3b8f2a1c9e4567890abcdef1234567890abcdef1234567890abcdef123456",
        created: "2026-07-14T09:32:11.418Z",
        duration: 18.42,
        channels: 1,
        models: ["30089e05-99d1-4376-b32e-c263170674af"],
        model_info: {
          "30089e05-99d1-4376-b32e-c263170674af": {
            name: "2-general-nova",
            version: "2024-01-09.29447",
            arch: "nova-2",
          },
        },
      },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "Thanks for calling support, how can I help you today?",
                confidence: 0.9942,
                words: [
                  {
                    word: "thanks",
                    start: 0.08,
                    end: 0.32,
                    confidence: 0.9976,
                    punctuated_word: "Thanks",
                  },
                  {
                    word: "for",
                    start: 0.32,
                    end: 0.48,
                    confidence: 0.9991,
                    punctuated_word: "for",
                  },
                  {
                    word: "calling",
                    start: 0.48,
                    end: 0.8,
                    confidence: 0.9958,
                    punctuated_word: "calling",
                  },
                  {
                    word: "support",
                    start: 0.8,
                    end: 1.24,
                    confidence: 0.9967,
                    punctuated_word: "support,",
                  },
                  {
                    word: "how",
                    start: 1.4,
                    end: 1.56,
                    confidence: 0.9989,
                    punctuated_word: "how",
                  },
                  {
                    word: "can",
                    start: 1.56,
                    end: 1.68,
                    confidence: 0.999,
                    punctuated_word: "can",
                  },
                  { word: "i", start: 1.68, end: 1.76, confidence: 0.9984, punctuated_word: "I" },
                  {
                    word: "help",
                    start: 1.76,
                    end: 2.0,
                    confidence: 0.9979,
                    punctuated_word: "help",
                  },
                  {
                    word: "you",
                    start: 2.0,
                    end: 2.16,
                    confidence: 0.9985,
                    punctuated_word: "you",
                  },
                  {
                    word: "today",
                    start: 2.16,
                    end: 2.48,
                    confidence: 0.9971,
                    punctuated_word: "today?",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    docsUrl: "https://developers.deepgram.com/docs/callback",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "deepgram",
    providerLabel: "Deepgram",
    eventType: "transcript.completed-multichannel",
    name: "Transcript completed (multichannel)",
    description:
      "A stereo recording transcribed with `multichannel=true`. `results.channels` has one entry per input channel (here, a two-line call recording with the agent on channel 0 and the customer on channel 1), each with its own alternatives.",
    body: {
      metadata: {
        transaction_key: "deprecated",
        request_id: "6f3a9e2d-4b1c-4a8e-9d5f-2c8b7a6e5d4c",
        sha256: "9a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f",
        created: "2026-07-13T15:04:52.907Z",
        duration: 42.19,
        channels: 2,
        models: ["30089e05-99d1-4376-b32e-c263170674af"],
        model_info: {
          "30089e05-99d1-4376-b32e-c263170674af": {
            name: "2-phonecall-nova",
            version: "2024-01-09.29447",
            arch: "nova-2",
          },
        },
      },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "Support line, this is Marcus, what's the account number on file?",
                confidence: 0.9861,
                words: [
                  {
                    word: "support",
                    start: 0.0,
                    end: 0.36,
                    confidence: 0.9944,
                    punctuated_word: "Support",
                  },
                  {
                    word: "line",
                    start: 0.36,
                    end: 0.6,
                    confidence: 0.9902,
                    punctuated_word: "line,",
                  },
                ],
              },
            ],
          },
          {
            alternatives: [
              {
                transcript: "Hi, it's ACC-58213, I can't access my dashboard.",
                confidence: 0.9714,
                words: [
                  { word: "hi", start: 3.1, end: 3.24, confidence: 0.9931, punctuated_word: "Hi," },
                  {
                    word: "it's",
                    start: 3.32,
                    end: 3.48,
                    confidence: 0.9822,
                    punctuated_word: "it's",
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    docsUrl: "https://developers.deepgram.com/docs/callback",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "deepgram",
    providerLabel: "Deepgram",
    eventType: "transcript.completed-diarized",
    name: "Transcript completed (diarized)",
    description:
      "A single-channel recording transcribed with `diarize=true` and `utterances=true`. Each word carries a `speaker` index, and `results.utterances` groups words into per-speaker turns.",
    body: {
      metadata: {
        transaction_key: "deprecated",
        request_id: "b1c8e4a7-3d92-4f6e-8a1b-5e9c7d2f4a83",
        sha256: "5e4d3c2b1a0f9e8d7c6b5a4938271605f4e3d2c1b0a9f8e7d6c5b4a39281706",
        created: "2026-07-12T11:47:03.220Z",
        duration: 61.05,
        channels: 1,
        models: ["e2f5b1c9-8a3d-4e7f-9c1a-2b6d8f4e5a70"],
        model_info: {
          "e2f5b1c9-8a3d-4e7f-9c1a-2b6d8f4e5a70": {
            name: "3-general",
            version: "2024-11-13.0",
            arch: "nova-3",
          },
        },
      },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript:
                  "Let's kick off the standup. I finished the migration script yesterday. Nice, I'll review the PR this morning.",
                confidence: 0.9788,
                words: [
                  {
                    word: "let's",
                    start: 0.04,
                    end: 0.28,
                    confidence: 0.9912,
                    punctuated_word: "Let's",
                    speaker: 0,
                  },
                  {
                    word: "kick",
                    start: 0.28,
                    end: 0.48,
                    confidence: 0.9955,
                    punctuated_word: "kick",
                    speaker: 0,
                  },
                  {
                    word: "i",
                    start: 3.12,
                    end: 3.2,
                    confidence: 0.988,
                    punctuated_word: "I",
                    speaker: 1,
                  },
                  {
                    word: "finished",
                    start: 3.2,
                    end: 3.56,
                    confidence: 0.9903,
                    punctuated_word: "finished",
                    speaker: 1,
                  },
                ],
              },
            ],
          },
        ],
        utterances: [
          {
            start: 0.04,
            end: 2.9,
            confidence: 0.9912,
            channel: 0,
            transcript: "Let's kick off the standup.",
            speaker: 0,
            id: "3f2a1b0c-9d8e-4f7a-6b5c-4d3e2f1a0b9c",
          },
          {
            start: 3.12,
            end: 5.64,
            confidence: 0.9903,
            channel: 0,
            transcript: "I finished the migration script yesterday.",
            speaker: 1,
            id: "8c7b6a5d-4e3f-2a1b-0c9d-8e7f6a5b4c3d",
          },
        ],
      },
    },
    docsUrl: "https://developers.deepgram.com/docs/callback",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "deepgram",
    providerLabel: "Deepgram",
    eventType: "transcript.failed",
    name: "Transcript failed",
    description:
      "Deepgram could not complete the job (here, fetching the source audio URL failed) and delivers its general API error shape to the callback URL instead of a results object.",
    body: {
      err_code: "REMOTE_CONTENT_ERROR",
      err_msg: "There was an error fetching the audio from the provided URL.",
      request_id: "a4e8d1c6-2f9b-4a3e-8d5c-1b6f9e2a7c4d",
    },
    docsUrl: "https://developers.deepgram.com/docs/callback",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
