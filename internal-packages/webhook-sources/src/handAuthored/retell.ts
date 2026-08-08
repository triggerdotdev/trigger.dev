import { type SampleRecord } from "../sampleRecord.js";

/**
 * Retell AI samples. Retell signs with `x-retell-signature: v={timestamp_ms},d={hex_digest}`
 * (HMAC-SHA256 over `rawBody + timestamp`), which does not match any of our verifier presets, so
 * these ship sample-only (no `presetId`). Every event is a thin envelope (`event`, `call`) where
 * `call` grows richer across the lifecycle: `call_started` carries basic call info, `call_ended`
 * adds timing/transcript/disconnection details, and `call_analyzed` adds the `call_analysis` object.
 */
export const samples: SampleRecord[] = [
  {
    provider: "retell",
    providerLabel: "Retell AI",
    eventType: "call_started",
    name: "Call started (phone)",
    description:
      "An inbound phone call was answered by the agent. `call.call_status` is `ongoing`.",
    body: {
      event: "call_started",
      call: {
        call_type: "phone_call",
        from_number: "+12137771234",
        to_number: "+12137771235",
        direction: "inbound",
        call_id: "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
        agent_id: "oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD",
        call_status: "ongoing",
        metadata: {},
        retell_llm_dynamic_variables: {
          customer_name: "John Doe",
        },
        start_timestamp: 1752562800000,
        opt_out_sensitive_data_storage: false,
      },
    },
    docsUrl: "https://docs.retellai.com/features/webhook-overview",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "retell",
    providerLabel: "Retell AI",
    eventType: "call_started",
    name: "Call started (web)",
    description:
      "A browser-based web call began. `call.call_type` is `web_call` and there are no phone numbers.",
    body: {
      event: "call_started",
      call: {
        call_type: "web_call",
        call_id: "kNc4mQZLPQfrTv8XoypA55rdYHmqTXcb",
        agent_id: "oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD",
        call_status: "ongoing",
        metadata: {
          session_source: "docs-widget",
        },
        retell_llm_dynamic_variables: {
          customer_name: "Priya Nair",
        },
        start_timestamp: 1752563400000,
        opt_out_sensitive_data_storage: false,
      },
    },
    docsUrl: "https://docs.retellai.com/features/webhook-overview",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "retell",
    providerLabel: "Retell AI",
    eventType: "call_ended",
    name: "Call ended (user hangup)",
    description:
      "The call finished normally. `call.disconnection_reason` is `user_hangup`; `call.transcript` and `call.transcript_object` hold the full conversation.",
    body: {
      event: "call_ended",
      call: {
        call_type: "phone_call",
        from_number: "+12137771234",
        to_number: "+12137771235",
        direction: "inbound",
        call_id: "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
        agent_id: "oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD",
        call_status: "ended",
        metadata: {},
        retell_llm_dynamic_variables: {
          customer_name: "John Doe",
        },
        start_timestamp: 1752562800000,
        end_timestamp: 1752562875000,
        disconnection_reason: "user_hangup",
        transcript:
          "Agent: Thanks for calling Acme Support, how can I help?\nUser: I need to reschedule my delivery.\nAgent: Sure, what date works best for you?\nUser: Next Tuesday please.",
        transcript_object: [
          { role: "agent", content: "Thanks for calling Acme Support, how can I help?", words: [] },
          { role: "user", content: "I need to reschedule my delivery.", words: [] },
          { role: "agent", content: "Sure, what date works best for you?", words: [] },
          { role: "user", content: "Next Tuesday please.", words: [] },
        ],
        recording_url: "https://retell-recordings.example.com/Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6.wav",
        opt_out_sensitive_data_storage: false,
      },
    },
    docsUrl: "https://docs.retellai.com/features/webhook-overview",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "retell",
    providerLabel: "Retell AI",
    eventType: "call_ended",
    name: "Call ended (voicemail)",
    description:
      "The call reached voicemail and Retell hung up. `call.disconnection_reason` is `voicemail_reached`.",
    body: {
      event: "call_ended",
      call: {
        call_type: "phone_call",
        from_number: "+14155550111",
        to_number: "+14155550199",
        direction: "outbound",
        call_id: "wRq2vBXNPLmztK9GhopY73rdCHmvTScf",
        agent_id: "oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD",
        call_status: "ended",
        metadata: {
          campaign_id: "appt-reminder-2026-07",
        },
        retell_llm_dynamic_variables: {
          customer_name: "Mateo Alvarez",
        },
        start_timestamp: 1752564000000,
        end_timestamp: 1752564018000,
        disconnection_reason: "voicemail_reached",
        transcript: "Agent: Hi, this is a reminder about your appointment tomorrow at 10am.",
        transcript_object: [
          {
            role: "agent",
            content: "Hi, this is a reminder about your appointment tomorrow at 10am.",
            words: [],
          },
        ],
        recording_url: "https://retell-recordings.example.com/wRq2vBXNPLmztK9GhopY73rdCHmvTScf.wav",
        opt_out_sensitive_data_storage: false,
      },
    },
    docsUrl: "https://docs.retellai.com/features/webhook-overview",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "retell",
    providerLabel: "Retell AI",
    eventType: "call_analyzed",
    name: "Call analyzed",
    description:
      "Post-call analysis finished. `call.call_analysis` carries the summary, sentiment, and success flag.",
    body: {
      event: "call_analyzed",
      call: {
        call_type: "phone_call",
        from_number: "+12137771234",
        to_number: "+12137771235",
        direction: "inbound",
        call_id: "Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6",
        agent_id: "oBeDLoLOeuAbiuaMFXRtDOLriTJ5tSxD",
        call_status: "ended",
        metadata: {},
        retell_llm_dynamic_variables: {
          customer_name: "John Doe",
        },
        start_timestamp: 1752562800000,
        end_timestamp: 1752562875000,
        duration_ms: 75000,
        disconnection_reason: "user_hangup",
        transcript:
          "Agent: Thanks for calling Acme Support, how can I help?\nUser: I need to reschedule my delivery.\nAgent: Sure, what date works best for you?\nUser: Next Tuesday please.",
        recording_url: "https://retell-recordings.example.com/Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6.wav",
        public_log_url: "https://retell-logs.example.com/Jabr9TXYYJHfvl6Syypi88rdAHYHmcq6/log.json",
        call_analysis: {
          call_summary:
            "Customer called to reschedule a delivery to next Tuesday; agent confirmed the new date.",
          user_sentiment: "Positive",
          call_successful: true,
          in_voicemail: false,
          custom_analysis_data: {
            reschedule_requested: true,
            new_delivery_date: "2026-07-21",
          },
        },
        opt_out_sensitive_data_storage: false,
      },
    },
    docsUrl: "https://docs.retellai.com/features/webhook-overview",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
