import { type SampleRecord } from "../sampleRecord.js";

/**
 * Zoom samples. Zoom signs webhooks with its own scheme (`x-zm-signature: v0=<hex>` over
 * `v0:{x-zm-request-timestamp}:{rawBody}`, HMAC-SHA256), which does not match any of our verifier
 * presets, so these ship sample-only (no `presetId`). Every event is a thin envelope
 * (`event`, `event_ts`, `payload: { account_id, object }`) where `object` carries the meeting or
 * recording resource.
 */
export const samples: SampleRecord[] = [
  {
    provider: "zoom",
    providerLabel: "Zoom",
    eventType: "meeting.started",
    name: "Meeting started",
    description: "A scheduled meeting began. `payload.object.id` is the meeting id.",
    body: {
      event: "meeting.started",
      event_ts: 1752562800000,
      payload: {
        account_id: "AAAAAABBBBBCCCCDDDD",
        object: {
          id: "84392028671",
          uuid: "4nR0i/L9Q2mfrfXtEWMnGA==",
          host_id: "z8yCxTTTTKWIFKy9d3VA",
          topic: "Weekly Product Sync",
          type: 8,
          start_time: "2026-07-15T14:00:00Z",
          timezone: "America/Los_Angeles",
          duration: 60,
        },
      },
    },
    docsUrl: "https://developers.zoom.us/docs/api/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "zoom",
    providerLabel: "Zoom",
    eventType: "meeting.ended",
    name: "Meeting ended",
    description: "A meeting finished. `payload.object.end_time` marks when it closed.",
    body: {
      event: "meeting.ended",
      event_ts: 1752566460000,
      payload: {
        account_id: "AAAAAABBBBBCCCCDDDD",
        object: {
          id: "84392028671",
          uuid: "4nR0i/L9Q2mfrfXtEWMnGA==",
          host_id: "z8yCxTTTTKWIFKy9d3VA",
          topic: "Weekly Product Sync",
          type: 8,
          start_time: "2026-07-15T14:00:00Z",
          end_time: "2026-07-15T15:01:00Z",
          duration: 60,
        },
      },
    },
    docsUrl: "https://developers.zoom.us/docs/api/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "zoom",
    providerLabel: "Zoom",
    eventType: "meeting.participant_joined",
    name: "Participant joined",
    description:
      "A participant joined the meeting. `payload.object.participant` carries their meeting-scoped id and join time.",
    body: {
      event: "meeting.participant_joined",
      event_ts: 1752562860000,
      payload: {
        account_id: "AAAAAABBBBBCCCCDDDD",
        object: {
          id: "84392028671",
          uuid: "4nR0i/L9Q2mfrfXtEWMnGA==",
          host_id: "z8yCxTTTTKWIFKy9d3VA",
          topic: "Weekly Product Sync",
          type: 8,
          start_time: "2026-07-15T14:00:00Z",
          timezone: "America/Los_Angeles",
          duration: 60,
          participant: {
            user_id: "16779264",
            user_name: "Priya Nair",
            id: "hK8fgZVOQkOKgOTgMFM2Jw",
            join_time: "2026-07-15T14:01:00Z",
            email: "priya.nair@example.com",
          },
        },
      },
    },
    docsUrl: "https://developers.zoom.us/docs/api/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "zoom",
    providerLabel: "Zoom",
    eventType: "meeting.participant_left",
    name: "Participant left",
    description:
      "A participant left the meeting. `payload.object.participant.leave_reason` explains why (e.g. left voluntarily, disconnected).",
    body: {
      event: "meeting.participant_left",
      event_ts: 1752565800000,
      payload: {
        account_id: "AAAAAABBBBBCCCCDDDD",
        object: {
          id: "84392028671",
          uuid: "4nR0i/L9Q2mfrfXtEWMnGA==",
          host_id: "z8yCxTTTTKWIFKy9d3VA",
          topic: "Weekly Product Sync",
          type: 8,
          start_time: "2026-07-15T14:00:00Z",
          timezone: "America/Los_Angeles",
          duration: 60,
          participant: {
            user_id: "16779264",
            user_name: "Priya Nair",
            id: "hK8fgZVOQkOKgOTgMFM2Jw",
            leave_time: "2026-07-15T14:50:00Z",
            leave_reason: "left the meeting",
            email: "priya.nair@example.com",
          },
        },
      },
    },
    docsUrl: "https://developers.zoom.us/docs/api/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "zoom",
    providerLabel: "Zoom",
    eventType: "recording.completed",
    name: "Recording completed",
    description:
      "Cloud recording processing finished. `payload.object.recording_files` lists each file with its `download_url`; `payload.object.download_token` is a short-lived bearer token for fetching them.",
    body: {
      event: "recording.completed",
      event_ts: 1752570120000,
      payload: {
        account_id: "AAAAAABBBBBCCCCDDDD",
        object: {
          id: "84392028671",
          uuid: "4nR0i/L9Q2mfrfXtEWMnGA==",
          account_id: "AAAAAABBBBBCCCCDDDD",
          host_id: "z8yCxTTTTKWIFKy9d3VA",
          topic: "Weekly Product Sync",
          type: 8,
          start_time: "2026-07-15T14:00:00Z",
          timezone: "America/Los_Angeles",
          host_email: "priya.nair@example.com",
          duration: 60,
          total_size: 52428800,
          recording_count: 2,
          share_url: "https://zoom.us/rec/share/abcDEF123ghiJKL456mnoPQR789stuVWX",
          recording_files: [
            {
              id: "9f8e7d6c-5b4a-3210-9f8e-7d6c5b4a3210",
              meeting_id: "4nR0i/L9Q2mfrfXtEWMnGA==",
              recording_start: "2026-07-15T14:00:05Z",
              recording_end: "2026-07-15T15:00:52Z",
              file_type: "MP4",
              file_extension: "MP4",
              file_size: 41943040,
              play_url: "https://zoom.us/rec/play/abcDEF123ghiJKL456mnoPQR789stuVWX",
              download_url: "https://zoom.us/rec/download/abcDEF123ghiJKL456mnoPQR789stuVWX",
              status: "completed",
              recording_type: "shared_screen_with_speaker_view",
            },
            {
              id: "1a2b3c4d-5e6f-7890-1a2b-3c4d5e6f7890",
              meeting_id: "4nR0i/L9Q2mfrfXtEWMnGA==",
              recording_start: "2026-07-15T14:00:05Z",
              recording_end: "2026-07-15T15:00:52Z",
              file_type: "M4A",
              file_extension: "M4A",
              file_size: 10485760,
              play_url: "https://zoom.us/rec/play/xyz987UVW654rstQPO321nml",
              download_url: "https://zoom.us/rec/download/xyz987UVW654rstQPO321nml",
              status: "completed",
              recording_type: "audio_only",
            },
          ],
          recording_play_passcode: "aB3dE9fG",
          download_token: "eyJhbGciOiJIUzUxMiJ9.fake-sample-token-not-real.signature",
        },
      },
    },
    docsUrl: "https://developers.zoom.us/docs/api/webhooks/",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
