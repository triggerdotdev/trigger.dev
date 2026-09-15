// Every id the demo layer produces contains "demo". Resource ids carry the marker
// inline: `trigger://` segments are percent-encoded, so `demo:` would render as `demo%3A`.
import { formatTriggerUri, type TriggerUri } from "@internal/dashboard-agent-contracts";

export const DEMO_ID_PREFIX = "demo:";

export const DEMO_MARKER = "demo";

export function demoId(rest: string): string {
  return `${DEMO_ID_PREFIX}${rest}`;
}

const DEMO_PROJECT_REF = "proj_demo00000000000000";
const DEMO_ENVIRONMENT_ID = "env_demo00000000000000";

const scope = { projectRef: DEMO_PROJECT_REF, environmentId: DEMO_ENVIRONMENT_ID };

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
  return formatTriggerUri({
    kind: "source",
    ...scope,
    sha,
    path,
    ...(line !== undefined ? { line } : {}),
  });
}

export const DEMO_WORLD = {
  failedRunId: "run_demo0f2c91",
  failedSpanId: "span_demoa41b",
  waitingRunId: "run_demo7b41ad",
  slowRunId: "run_democ0113e",
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
