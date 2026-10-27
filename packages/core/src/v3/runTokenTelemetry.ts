import { diag } from "@opentelemetry/api";
import { VERSION } from "../version.js";
import { isRunTokenOperation } from "./runTokenOperations.js";
import type { SdkCredentialTelemetryReason } from "./sdkCredentialTelemetry.js";
import { taskContext } from "./task-context-api.js";

export type RunTokenSelectionReason = SdkCredentialTelemetryReason | "outside_task";

const reportedFallbacks = new Set<string>();

export function recordRunTokenSelection(
  operation: string,
  credential: string | undefined,
  reason: RunTokenSelectionReason
): void {
  if (!taskContext.isInsideTask || reason === "selected" || reason === "outside_task") return;
  const boundedOperation = isRunTokenOperation(operation) ? operation : "unknown";
  const key = `${boundedOperation}:${reason}`;
  if (reportedFallbacks.has(key)) return;
  reportedFallbacks.add(key);

  // The global MeterProvider exports customer metrics, not internal rollout telemetry.
  try {
    diag.debug("Trigger.dev SDK run-token compatibility fallback", {
      operation: boundedOperation,
      credential_kind: credential ? "fallback" : "none",
      reason,
      sdk_version: VERSION,
    });
  } catch {
    // Diagnostics must not prevent an API request.
  }
}
