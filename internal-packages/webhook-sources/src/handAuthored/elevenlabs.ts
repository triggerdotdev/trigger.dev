import { type SampleRecord } from "../sampleRecord.js";

/**
 * ElevenLabs Conversational AI post-call samples. No preset: ElevenLabs signs with
 * `elevenlabs-signature: t=<unix>,v0=<hex>` (HMAC-SHA256 over `{timestamp}.{rawBody}`), which is close
 * to but does not exactly match our `stripe` preset's header name or `v1=` value prefix. Every body is
 * the thin `{ type, event_timestamp, data }` envelope; `post_call_audio` carries only three fields by
 * design (no transcript/metadata/analysis).
 */
export const samples: SampleRecord[] = [
  {
    provider: "elevenlabs",
    providerLabel: "ElevenLabs",
    eventType: "post_call_transcription",
    name: "Post-call transcription (successful call)",
    description:
      "Full conversation data delivered after a call ends: transcript turns, call metadata, and analysis results.",
    body: {
      type: "post_call_transcription",
      event_timestamp: 1752562811,
      data: {
        agent_id: "xI1AVR5jrfLZ6mSjxgTS",
        agent_name: "Support Agent",
        conversation_id: "conv_4f9b2e7c1a8d6f3e0b5c",
        status: "done",
        user_id: "user_8a2d5f1c9e7b3a6d",
        authorization_method: "signed_url",
        transcript: [
          {
            role: "agent",
            message: "Hi, thanks for calling. How can I help you today?",
            tool_calls: null,
            tool_results: null,
            feedback: null,
            time_in_call_secs: 0,
            conversation_turn_metrics: null,
          },
          {
            role: "user",
            message: "I need to check the status of my last order.",
            tool_calls: null,
            tool_results: null,
            feedback: null,
            time_in_call_secs: 4,
            conversation_turn_metrics: null,
          },
          {
            role: "agent",
            message: "Your order shipped yesterday and should arrive by Friday.",
            tool_calls: null,
            tool_results: null,
            feedback: null,
            time_in_call_secs: 9,
            conversation_turn_metrics: null,
          },
        ],
        metadata: {
          start_time_unix_secs: 1752562780,
          call_duration_secs: 31,
          cost: 412,
          deletion_settings: {
            deletion_time_unix_secs: null,
            deleted_logs_at_time_unix_secs: null,
            deleted_audio_at_time_unix_secs: null,
            deleted_transcript_at_time_unix_secs: null,
            delete_transcript_and_pii: false,
            delete_audio: false,
          },
          feedback: {
            overall_score: null,
            likes: 0,
            dislikes: 0,
          },
          authorization_method: "signed_url",
          charging: {
            dev_discount: false,
          },
          termination_reason: "the conversation was ended by the user",
        },
        analysis: {
          evaluation_criteria_results: {},
          data_collection_results: {},
          call_successful: "success",
          transcript_summary:
            "Caller asked for their order status; agent confirmed shipping and ETA.",
        },
        conversation_initiation_client_data: {
          dynamic_variables: {
            customer_name: "Priya Nair",
          },
        },
      },
    },
    docsUrl: "https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "elevenlabs",
    providerLabel: "ElevenLabs",
    eventType: "post_call_transcription",
    name: "Post-call transcription (tool call, evaluation failed)",
    description:
      "A transcript where the agent invoked a tool mid-call and the post-call evaluation criteria did not pass.",
    body: {
      type: "post_call_transcription",
      event_timestamp: 1752563912,
      data: {
        agent_id: "xI1AVR5jrfLZ6mSjxgTS",
        agent_name: "Booking Agent",
        conversation_id: "conv_9c3a7e1f5b2d8c4a6f0e",
        status: "done",
        user_id: "user_1b6e9a3f7c2d5b8e",
        authorization_method: "public",
        transcript: [
          {
            role: "agent",
            message: "Let me look up available slots for you.",
            tool_calls: [
              {
                tool_name: "check_availability",
                tool_call_id: "tool_call_7d2e4c1b",
                params_as_json: '{"date":"2026-07-20"}',
              },
            ],
            tool_results: null,
            feedback: null,
            time_in_call_secs: 6,
            conversation_turn_metrics: null,
          },
          {
            role: "agent",
            message: "There are no slots left on that date, unfortunately.",
            tool_calls: null,
            tool_results: [
              {
                tool_name: "check_availability",
                tool_call_id: "tool_call_7d2e4c1b",
                result_value: '{"slots":[]}',
              },
            ],
            feedback: null,
            time_in_call_secs: 8,
            conversation_turn_metrics: null,
          },
        ],
        metadata: {
          start_time_unix_secs: 1752563890,
          call_duration_secs: 22,
          cost: 298,
          deletion_settings: {
            deletion_time_unix_secs: null,
            deleted_logs_at_time_unix_secs: null,
            deleted_audio_at_time_unix_secs: null,
            deleted_transcript_at_time_unix_secs: null,
            delete_transcript_and_pii: false,
            delete_audio: false,
          },
          feedback: {
            overall_score: 2,
            likes: 0,
            dislikes: 1,
          },
          authorization_method: "public",
          charging: {
            dev_discount: false,
          },
          termination_reason: "client disconnected",
        },
        analysis: {
          evaluation_criteria_results: {
            resolved_user_request: {
              result: "failure",
              rationale: "No booking slot was found or offered as an alternative.",
            },
          },
          data_collection_results: {},
          call_successful: "failure",
          transcript_summary:
            "Caller wanted to book a slot; none were available and no alternative was offered.",
        },
        conversation_initiation_client_data: {
          dynamic_variables: {
            requested_date: "2026-07-20",
          },
        },
      },
    },
    docsUrl: "https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "elevenlabs",
    providerLabel: "ElevenLabs",
    eventType: "post_call_audio",
    name: "Post-call audio",
    description:
      "Minimal payload delivered separately from transcription webhooks, carrying only the base64-encoded MP3 of the full call. No transcript, metadata, or analysis fields are included.",
    body: {
      type: "post_call_audio",
      event_timestamp: 1752562819,
      data: {
        agent_id: "xI1AVR5jrfLZ6mSjxgTS",
        conversation_id: "conv_4f9b2e7c1a8d6f3e0b5c",
        full_audio:
          "SUQzBAAAAAAAI1RTU0UAAAAPAAADTGF2ZjU4LjI5LjEwMAAAAAAAAAAAAAAA//sample-not-real-audio-bytes",
      },
    },
    docsUrl: "https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "elevenlabs",
    providerLabel: "ElevenLabs",
    eventType: "call_initiation_failure",
    name: "Call initiation failure (SIP, busy)",
    description:
      "The outbound call never connected because the SIP trunk reported the line as busy. `data.metadata.body` carries the SIP-specific failure detail.",
    body: {
      type: "call_initiation_failure",
      event_timestamp: 1752564001,
      data: {
        agent_id: "xI1AVR5jrfLZ6mSjxgTS",
        conversation_id: "conv_2e8c5a1f9b3d7c4e6a0f",
        failure_reason: "busy",
        metadata: {
          type: "sip",
          body: {
            from_number: 15550001234,
            to_number: 15550005678,
            sip_status_code: 486,
            error_reason: "Busy Here",
            call_sid: "sip_call_3a7e1c9d5b2f",
            sip_status: "486 Busy Here",
            twirp_code: "unavailable",
          },
        },
      },
    },
    docsUrl: "https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "elevenlabs",
    providerLabel: "ElevenLabs",
    eventType: "call_initiation_failure",
    name: "Call initiation failure (Twilio, no answer)",
    description:
      "The outbound call was routed through Twilio and rang without being answered. `data.metadata.body` follows Twilio's StatusCallback field names.",
    body: {
      type: "call_initiation_failure",
      event_timestamp: 1752564205,
      data: {
        agent_id: "xI1AVR5jrfLZ6mSjxgTS",
        conversation_id: "conv_7b1d4f9a2c6e8b3d5f0a",
        failure_reason: "no-answer",
        metadata: {
          type: "twilio",
          body: {
            Called: "+15550005678",
            Caller: "+15550001234",
            CallSid: "CAfake1234567890abcdef1234567890",
            CallStatus: "no-answer",
            SipResponseCode: "480",
          },
        },
      },
    },
    docsUrl: "https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
