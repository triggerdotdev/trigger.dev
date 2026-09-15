import { type SampleRecord } from "../sampleRecord.js";

/**
 * Anthropic (Managed Agents) webhook samples. Anthropic signs deliveries with a single
 * `X-Webhook-Signature` header (secret `whsec_`-prefixed, verified via the SDK's
 * `client.beta.webhooks.unwrap()`), not the three-header Standard Webhooks scheme our `svix`
 * preset verifies, so these ship sample-only (no `presetId`). Every payload is a deliberately
 * thin envelope: `{ type: "event", id, created_at, data: { type, id, organization_id,
 * workspace_id } }`. Anthropic does not include the full resource in the delivery, by design
 * ("avoids delivering stale data on retries and keeps every delivery small") — the integrator
 * is expected to follow up with a `GET` against `data.id` (e.g. `sessions.retrieve(data.id)`).
 */
export const samples: SampleRecord[] = [
  {
    provider: "anthropic",
    providerLabel: "Anthropic (Claude)",
    eventType: "session.status_run_started",
    name: "Session run started",
    description:
      "A Managed Agents session transitioned to running. Fires on every transition into that status, not just the first. `data.id` is the session id; fetch it with `sessions.retrieve()` for the current state.",
    body: {
      type: "event",
      id: "event_01HZXQ2K8VN3R5T7WA9BCEFGH",
      created_at: "2026-07-14T09:12:03Z",
      data: {
        type: "session.status_run_started",
        id: "sesn_01JX4KPQF7VN2R8TA9WBCDEFH",
        organization_id: "8a3d2f1e-6b47-4c9a-9d2e-1f5c8a3b7e6d",
        workspace_id: "c7b0e4d9-2a1f-4e6b-8c3d-5f9a7b2e4d1c",
      },
    },
    docsUrl: "https://platform.claude.com/docs/en/managed-agents/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "anthropic",
    providerLabel: "Anthropic (Claude)",
    eventType: "session.status_idled",
    name: "Session idled",
    description:
      "The agent is awaiting input — a tool permission approval or the next user message. `data.id` is the same session id from the run-started event; fetch it to read `stop_reason`.",
    body: {
      type: "event",
      id: "event_01HZXQ3M9WP4S6U8XB1CDFGHJ",
      created_at: "2026-07-14T09:14:47Z",
      data: {
        type: "session.status_idled",
        id: "sesn_01JX4KPQF7VN2R8TA9WBCDEFH",
        organization_id: "8a3d2f1e-6b47-4c9a-9d2e-1f5c8a3b7e6d",
        workspace_id: "c7b0e4d9-2a1f-4e6b-8c3d-5f9a7b2e4d1c",
      },
    },
    docsUrl: "https://platform.claude.com/docs/en/managed-agents/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "anthropic",
    providerLabel: "Anthropic (Claude)",
    eventType: "deployment_run.succeeded",
    name: "Deployment run succeeded",
    description:
      "A scheduled deployment's cron firing created its session. `data.id` is the deployment run id (`drun_...`), not the session id — fetch the deployment run for its `session_id`, then subscribe to that session's events.",
    body: {
      type: "event",
      id: "event_01HZXQ5R2YT6V9WA3CEGHJKLM",
      created_at: "2026-07-14T20:00:01Z",
      data: {
        type: "deployment_run.succeeded",
        id: "drun_01KM8NRTV2WY4Z6A9CDEFGHJ",
        organization_id: "8a3d2f1e-6b47-4c9a-9d2e-1f5c8a3b7e6d",
        workspace_id: "c7b0e4d9-2a1f-4e6b-8c3d-5f9a7b2e4d1c",
      },
    },
    docsUrl: "https://platform.claude.com/docs/en/managed-agents/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "anthropic",
    providerLabel: "Anthropic (Claude)",
    eventType: "deployment_run.failed",
    name: "Deployment run failed",
    description:
      "A scheduled deployment's cron firing did not create a session (e.g. the environment was archived, or the vault credential was missing). `data.id` is the deployment run id; fetch it for `error.type` / `error.message`.",
    body: {
      type: "event",
      id: "event_01HZXQ6T4ZV8WB5CEGHJKLMNP",
      created_at: "2026-07-15T02:00:02Z",
      data: {
        type: "deployment_run.failed",
        id: "drun_01KM9PSUW3XZ5A7BDEFGHJKM",
        organization_id: "8a3d2f1e-6b47-4c9a-9d2e-1f5c8a3b7e6d",
        workspace_id: "c7b0e4d9-2a1f-4e6b-8c3d-5f9a7b2e4d1c",
      },
    },
    docsUrl: "https://platform.claude.com/docs/en/managed-agents/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
  {
    provider: "anthropic",
    providerLabel: "Anthropic (Claude)",
    eventType: "agent.updated",
    name: "Agent updated",
    description:
      "A new version of an agent config was published (updates that don't create a new version don't fire this). `data.id` is the agent id; fetch it for the new `version` and config.",
    body: {
      type: "event",
      id: "event_01HZXQ7V6BW1XC7DFHJKLMNPQ",
      created_at: "2026-07-15T11:30:19Z",
      data: {
        type: "agent.updated",
        id: "agent_01LN2QTVX4YZ6B8CEFGHJKLN",
        organization_id: "8a3d2f1e-6b47-4c9a-9d2e-1f5c8a3b7e6d",
        workspace_id: "c7b0e4d9-2a1f-4e6b-8c3d-5f9a7b2e4d1c",
      },
    },
    docsUrl: "https://platform.claude.com/docs/en/managed-agents/webhooks",
    provenance: { kind: "handauthored", snapshotDate: "2026-07" },
  },
];
