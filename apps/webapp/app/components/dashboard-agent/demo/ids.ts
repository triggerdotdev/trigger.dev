// Every id the demo layer produces contains "demo".
export const DEMO_ID_PREFIX = "demo:";

export function demoId(rest: string): string {
  return `${DEMO_ID_PREFIX}${rest}`;
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
