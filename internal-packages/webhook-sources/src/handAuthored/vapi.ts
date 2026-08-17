import { type SampleRecord } from "../sampleRecord.js";

/**
 * Vapi server webhook samples. Every message is wrapped in a top-level `message` object whose `type`
 * field is the event discriminant (`eventType` mirrors it here). Vapi signs with a bespoke
 * `x-vapi-signature` header (raw HMAC-SHA256 hex digest of the raw body, integrator-configured secret,
 * no timestamp/prefix), which does not match any of our verifier presets, so these ship sample-only
 * with no `presetId`.
 */
export const samples: SampleRecord[] = [
  {
    provider: "vapi",
    providerLabel: "Vapi",
    eventType: "status-update",
    name: "Status update",
    description: "The call transitioned to a new status, here from ringing to in-progress.",
    body: {
      message: {
        type: "status-update",
        status: "in-progress",
        timestamp: 1783533600123,
        call: {
          id: "call_29a1f6a0-6b3d-4e2a-9c7d-8f5e6a2b1c40",
          orgId: "org_4f6e2a91-7c3b-4d5a-9e1f-2b8c6d4a3f90",
          type: "outboundPhoneCall",
          status: "in-progress",
          createdAt: "2026-07-14T18:59:57.201Z",
          updatedAt: "2026-07-14T19:00:00.123Z",
          assistantId: "asst_7d4c2b91-3a6e-4f8d-b1c5-9e2a7d6c4b30",
          phoneNumberId: "pn_5b3d8a92-1c4e-4a7f-9d6b-2e8c1a4f7b60",
          customer: {
            number: "+14155550142",
          },
        },
      },
    },
    docsUrl: "https://docs.vapi.ai/server-url/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "vapi",
    providerLabel: "Vapi",
    eventType: "transcript",
    name: "Transcript",
    description: "A final transcript chunk from the caller's turn.",
    body: {
      message: {
        type: "transcript",
        role: "user",
        transcriptType: "final",
        transcript: "I need to reschedule my appointment to next Tuesday afternoon.",
        call: {
          id: "call_29a1f6a0-6b3d-4e2a-9c7d-8f5e6a2b1c40",
          orgId: "org_4f6e2a91-7c3b-4d5a-9e1f-2b8c6d4a3f90",
          type: "outboundPhoneCall",
          status: "in-progress",
          assistantId: "asst_7d4c2b91-3a6e-4f8d-b1c5-9e2a7d6c4b30",
          customer: {
            number: "+14155550142",
          },
        },
      },
    },
    docsUrl: "https://docs.vapi.ai/server-url/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "vapi",
    providerLabel: "Vapi",
    eventType: "tool-calls",
    name: "Tool calls",
    description:
      "The assistant invoked a configured function tool; the server is expected to respond with the tool's result.",
    body: {
      message: {
        type: "tool-calls",
        toolCallList: [
          {
            id: "tool_call_8c2d6a91-4b7e-4f3a-9d1c-6e8a2b4f7c50",
            type: "function",
            function: {
              name: "reschedule_appointment",
              arguments: '{"appointmentId":"appt_5120","newTime":"2026-07-21T14:00:00-07:00"}',
            },
          },
        ],
        call: {
          id: "call_29a1f6a0-6b3d-4e2a-9c7d-8f5e6a2b1c40",
          orgId: "org_4f6e2a91-7c3b-4d5a-9e1f-2b8c6d4a3f90",
          type: "outboundPhoneCall",
          status: "in-progress",
          assistantId: "asst_7d4c2b91-3a6e-4f8d-b1c5-9e2a7d6c4b30",
          customer: {
            number: "+14155550142",
          },
        },
      },
    },
    docsUrl: "https://docs.vapi.ai/server-url/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "vapi",
    providerLabel: "Vapi",
    eventType: "end-of-call-report",
    name: "End of call report",
    description:
      "Sent once the call ends, carrying the ended reason plus the full artifact (transcript, messages, recording).",
    body: {
      message: {
        type: "end-of-call-report",
        endedReason: "customer-ended-call",
        durationSeconds: 187.4,
        cost: 0.0932,
        call: {
          id: "call_29a1f6a0-6b3d-4e2a-9c7d-8f5e6a2b1c40",
          orgId: "org_4f6e2a91-7c3b-4d5a-9e1f-2b8c6d4a3f90",
          type: "outboundPhoneCall",
          status: "ended",
          createdAt: "2026-07-14T18:59:57.201Z",
          updatedAt: "2026-07-14T19:03:04.612Z",
          assistantId: "asst_7d4c2b91-3a6e-4f8d-b1c5-9e2a7d6c4b30",
          customer: {
            number: "+14155550142",
          },
        },
        artifact: {
          transcript:
            "AI: Hi, this is Riley from Sunrise Dental. How can I help?\nUser: I need to reschedule my appointment to next Tuesday afternoon.\nAI: Sure, I've moved your appointment to Tuesday at 2pm.",
          messages: [
            {
              role: "assistant",
              message: "Hi, this is Riley from Sunrise Dental. How can I help?",
              time: 1783533601400,
              endTime: 1783533604100,
            },
            {
              role: "user",
              message: "I need to reschedule my appointment to next Tuesday afternoon.",
              time: 1783533605200,
              endTime: 1783533608700,
            },
            {
              role: "assistant",
              message: "Sure, I've moved your appointment to Tuesday at 2pm.",
              time: 1783533609300,
              endTime: 1783533612100,
            },
          ],
          recording: {
            stereoUrl:
              "https://storage.vapi.ai/recordings/call_29a1f6a0-6b3d-4e2a-9c7d-8f5e6a2b1c40.wav",
          },
        },
      },
    },
    docsUrl: "https://docs.vapi.ai/server-url/events",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
