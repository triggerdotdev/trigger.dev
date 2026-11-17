import type { AuthenticatedEnvironment } from "@trigger.dev/core/v3/auth/environment";
import {
  isSdkCredentialTelemetryOperation,
  isSdkCredentialTelemetryReason,
  SDK_CREDENTIAL_OPERATION_HEADER,
  SDK_CREDENTIAL_REASON_HEADER,
} from "@trigger.dev/core/v3";
import {
  createMetricsAggregator,
  type MetricsAggregatorOptions,
  type MetricsTenant,
} from "./metricsAggregator.server";

type AuthenticatedTenant = Pick<AuthenticatedEnvironment, "id" | "organizationId" | "projectId">;
type UsageOptions = Omit<MetricsAggregatorOptions<MetricsTenant>, "name" | "isEnabled">;

export function createRootKeyUsageAggregator(options: UsageOptions) {
  const metrics = createMetricsAggregator({
    ...options,
    name: "tenant root-key usage",
    isEnabled: () => true,
  });
  const recorded = new WeakSet<Request>();
  const now = options.now ?? Date.now;

  // Only call after successful authentication. Headers never supply tenant identity.
  const record = (request: Request, credentialKind: string, environment: AuthenticatedTenant) => {
    if (credentialKind !== "root_api_key" && credentialKind !== "run_token") return;
    if (recorded.has(request)) return;
    recorded.add(request);

    const hasSelection =
      isSdkCredentialTelemetryOperation(request.headers.get(SDK_CREDENTIAL_OPERATION_HEADER)) &&
      isSdkCredentialTelemetryReason(request.headers.get(SDK_CREDENTIAL_REASON_HEADER));
    const hasTaskHint =
      request.headers.get("x-trigger-worker") === "true" ||
      request.headers.has("x-trigger-run-id") ||
      hasSelection;
    const source =
      credentialKind === "run_token"
        ? "authenticated_run"
        : hasTaskHint
          ? "task_hint"
          : "unknown_origin";

    metrics.record(
      {
        organizationId: environment.organizationId,
        projectId: environment.projectId,
        environmentId: environment.id,
      },
      [{ name: source, reducer: "max", value: now() }]
    );
  };

  return { record, flush: metrics.flush, start: metrics.start, stop: metrics.stop };
}
