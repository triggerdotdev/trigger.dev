import { getMeter } from "@internal/tracing";
import { singleton } from "~/utils/singleton";

export type SecretProxyFailureReason =
  | "service_auth"
  | "token"
  | "run_state"
  | "disabled"
  | "capability"
  | "environment"
  | "policy"
  | "placeholder"
  | "secret_unavailable"
  | "expired"
  | "limit"
  | "dependency"
  | "signing"
  | "requeue";

type FailureOperation = "metadata" | "guard" | "preflight" | "resolve" | "signing";

function telemetry() {
  return singleton("secretProxyTelemetry", () => {
    const meter = getMeter("secret-proxy");
    const failures = meter.createCounter("secret_proxy.failures", {
      description: "Proxy check failures and refusals by bounded operation and reason",
    });
    const reasons: Record<FailureOperation, readonly SecretProxyFailureReason[]> = {
      metadata: ["dependency"],
      guard: ["policy"],
      preflight: [
        "disabled",
        "capability",
        "token",
        "environment",
        "policy",
        "limit",
        "dependency",
      ],
      resolve: [
        "service_auth",
        "token",
        "run_state",
        "disabled",
        "policy",
        "placeholder",
        "secret_unavailable",
        "expired",
        "limit",
        "dependency",
      ],
      signing: ["signing", "requeue"],
    };
    for (const [operation, values] of Object.entries(reasons)) {
      for (const reason of values) failures.add(0, { operation, reason });
    }
    const delivery = meter.createCounter("secret_proxy.delivery.requests", {
      description: "Variable preparation and proxy preflight outcomes, not executed runs",
    });
    for (const enabled of [false, true]) {
      for (const outcome of ["ordinary", "protected", "error"]) {
        delivery.add(0, { phase: "prepare", enabled: enabled ? "true" : "false", outcome });
      }
      for (const outcome of ["protected", "denied", "error"]) {
        delivery.add(0, { phase: "preflight", enabled: enabled ? "true" : "false", outcome });
      }
    }
    return { failures, delivery };
  });
}

export function recordSecretProxyFailure(
  operation: FailureOperation,
  reason: SecretProxyFailureReason
) {
  telemetry().failures.add(1, { operation, reason });
}

export function recordSecretProxyDelivery(
  phase: "prepare" | "preflight",
  enabled: boolean,
  outcome: "ordinary" | "protected" | "denied" | "error"
) {
  telemetry().delivery.add(1, { phase, enabled: enabled ? "true" : "false", outcome });
}
