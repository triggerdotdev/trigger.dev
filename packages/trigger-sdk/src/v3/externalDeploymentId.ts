import {
  apiClientManager,
  getEnvVar,
  resolveExternalDeploymentId,
  sdkScope,
  type SessionTriggerConfig,
} from "@trigger.dev/core/v3";

/** Reads an env var unless the scope opted out of ambient context (`inheritContext: false`). */
export function scopedEnvVar(name: string): string | undefined {
  const scope = sdkScope.getStore();
  if (scope && !scope.inheritContext) return undefined;
  return getEnvVar(name);
}

/**
 * Precedence: an explicit value, the client config, `TRIGGER_EXTERNAL_DEPLOYMENT_ID`, then
 * platform/CI commit vars when automatic skew protection is on. `null` is an explicit opt-out.
 */
export function resolveTriggerExternalDeploymentId(explicit?: string | null): string | undefined {
  if (explicit === null) return undefined;

  return resolveExternalDeploymentId({
    explicit,
    clientConfig: apiClientManager.externalDeploymentId,
    read: scopedEnvVar,
  });
}

/** A session trigger config as callers write it: the pin is optional, and `null` opts out. */
type TriggerConfigInput = Omit<SessionTriggerConfig, "externalDeploymentId"> & {
  externalDeploymentId?: string | null;
};

/**
 * Fill in `triggerConfig.externalDeploymentId` on an outgoing session-create body, at each point
 * one leaves the SDK. Discovery has to happen here rather than server-side: the commit SHA lives
 * in the calling application's runtime, so the caller's build is what selects the agent version.
 */
export function withResolvedExternalDeploymentId<
  TBody extends { triggerConfig: TriggerConfigInput },
>(body: TBody): TBody & { triggerConfig: SessionTriggerConfig } {
  const resolved = resolveTriggerExternalDeploymentId(body.triggerConfig.externalDeploymentId);
  const { externalDeploymentId: _omit, ...rest } = body.triggerConfig;

  return {
    ...body,
    triggerConfig: {
      ...rest,
      ...(resolved ? { externalDeploymentId: resolved } : {}),
    },
  };
}
