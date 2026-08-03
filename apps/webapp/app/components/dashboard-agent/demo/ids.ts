/**
 * Demo-mode identity rules. Everything the demo layer invents lives in its own
 * namespace so a demo artefact can never be mistaken for — or written next to —
 * a real one.
 *
 * Two conventions, on purpose:
 *
 * 1. **Our own namespace** (chats, investigations, watches) uses the literal
 *    `demo:` prefix, so `isDemoChatId` answers "this id is a fixture, never
 *    talk to the server about it".
 * 2. **Resource ids** (runs, queues, errors, deployments, source shas) keep
 *    their real-world shape but always carry the `demo` marker inside the id
 *    (`run_demo0f2c91`, `demo-email-sends`). They have to stay shaped like real
 *    ids because they travel through `trigger://` URIs, whose grammar is frozen
 *    and whose segments are percent-encoded — a `demo:` prefix would render as
 *    `demo%3A…` in every citation and make the mockup unreadable.
 *
 * The invariant both conventions share, and the one the test enforces: every id
 * the demo layer produces contains the string `demo`.
 */
import { formatTriggerUri, type TriggerUri } from "@internal/dashboard-agent-contracts";

/** Prefix for every id in the demo layer's own namespace. */
export const DEMO_ID_PREFIX = "demo:";

/** The marker every demo id — ours or resource-shaped — must contain. */
export const DEMO_MARKER = "demo";

/** `demo:` + the rest. Use for chats, investigations and watches. */
export function demoId(rest: string): string {
  return `${DEMO_ID_PREFIX}${rest}`;
}

/**
 * True for a chat id the demo registry owns — cheap and total, no lookups and
 * no async, so any renderer can ask before it touches the server.
 */
export function isDemoChatId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(DEMO_ID_PREFIX);
}

/** The fake project/environment every demo `trigger://` URI is scoped to. */
export const DEMO_PROJECT_REF = "proj_demo00000000000000";
export const DEMO_ENVIRONMENT_ID = "env_demo00000000000000";

const scope = { projectRef: DEMO_PROJECT_REF, environmentId: DEMO_ENVIRONMENT_ID };

// Builders go through `formatTriggerUri` rather than string templates so every
// fixture URI is grammar-valid by construction — the contracts package, not the
// fixture author, decides what a legal URI looks like.

export function demoRunsUri(): TriggerUri {
  return formatTriggerUri({ kind: "runs", ...scope });
}

export function demoRunUri(runId: string): TriggerUri {
  return formatTriggerUri({ kind: "run", ...scope, runId });
}

export function demoSpanUri(runId: string, spanId: string): TriggerUri {
  return formatTriggerUri({ kind: "span", ...scope, runId, spanId });
}

export function demoErrorUri(fingerprint: string): TriggerUri {
  return formatTriggerUri({ kind: "error", ...scope, fingerprint });
}

export function demoQueueUri(name: string): TriggerUri {
  return formatTriggerUri({ kind: "queue", ...scope, name });
}

export function demoDeploymentUri(version: string): TriggerUri {
  return formatTriggerUri({ kind: "deployment", ...scope, version });
}

export function demoReportUri(key: string): TriggerUri {
  return formatTriggerUri({ kind: "report", ...scope, key });
}

export function demoSourceUri(sha: string, path: string, line?: number): TriggerUri {
  return formatTriggerUri({ kind: "source", ...scope, sha, path, ...(line ? { line } : {}) });
}

export function demoInvestigationUri(investigationId: string): TriggerUri {
  return formatTriggerUri({ kind: "investigation", ...scope, investigationId });
}

// ---------------------------------------------------------------------------
// The demo world: one small, consistent cast of resources every fixture reuses,
// so the mockup reads as one environment rather than a pile of unrelated cards.
// ---------------------------------------------------------------------------

export const DEMO_WORLD = {
  /** The failing run at the centre of the Investigate flow. */
  failedRunId: "run_demo0f2c91",
  failedSpanId: "span_demoa41b",
  /** A run that is sitting in the queue rather than executing. */
  waitingRunId: "run_demo7b41ad",
  /** A run running well past its task's usual duration. */
  slowRunId: "run_democ0113e",
  /** A historical run that failed the same way. */
  priorRunId: "run_demo4419bb",
  taskId: "send-order-receipt",
  slowTaskId: "generate-monthly-report",
  queue: "demo-email-sends",
  backlogQueue: "demo-backlog-drain",
  errorFingerprint: "error_demo5a1c73",
  deploymentVersion: "20260726.4-demo",
  sourceSha: "demo1a2b3c4d5e6f70",
  sourcePath: "src/trigger/sendOrderReceipt.ts",
  reportKey: "health",
} as const;
