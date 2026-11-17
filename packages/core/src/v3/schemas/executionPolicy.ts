import { z } from "zod/v4";

export const RUN_SCOPE_PLACEHOLDER = "$run";
/**
 * `triggerSource` sent for sandbox tasks. Older CLIs drop the `sandbox` field when indexing but
 * keep `triggerSource`, so the server can reject a sandbox whose config was lost.
 */
export const SANDBOX_TRIGGER_SOURCE = "sandbox";
export const SESSION_SCOPE_PLACEHOLDER = "$session";

const MAX_GRANTED_ENV_VARS = 256;
const MAX_POLICY_SCOPES = 64;

/** Environment variables a run may receive. Delivery mode follows each variable's own proxy setting. */
export const EnvVarGrant = z.union([
  z.literal("all"),
  z.array(z.string().min(1)).max(MAX_GRANTED_ENV_VARS),
]);
export type EnvVarGrant = z.infer<typeof EnvVarGrant>;

/**
 * What a run may access. Absent means the standard behaviour: root key, admin run token and every
 * environment variable. Scopes may contain `$run` and `$session`, filled in when the token is minted.
 */
export const RunExecutionPolicy = z.object({
  version: z.literal(1),
  rootKey: z.boolean(),
  scopes: z.array(z.string().min(1)).max(MAX_POLICY_SCOPES),
  envVars: EnvVarGrant,
});
export type RunExecutionPolicy = z.infer<typeof RunExecutionPolicy>;

/** Task declaration for `sandbox.define()`, sent in the worker manifest. */
export const SandboxTaskConfig = z.object({
  envVars: EnvVarGrant.optional(),
});
export type SandboxTaskConfig = z.infer<typeof SandboxTaskConfig>;

export function sandboxExecutionPolicy(config: SandboxTaskConfig): RunExecutionPolicy {
  return {
    version: 1,
    rootKey: false,
    scopes: [
      `read:runs:${RUN_SCOPE_PLACEHOLDER}`,
      `write:runs:${RUN_SCOPE_PLACEHOLDER}`,
      `read:sessions:${SESSION_SCOPE_PLACEHOLDER}:in`,
      `write:sessions:${SESSION_SCOPE_PLACEHOLDER}:out`,
      "write:oidc",
    ],
    envVars: config.envVars ?? [],
  };
}

/** Fills in placeholders. Scopes whose placeholder has no value are dropped, never minted literally. */
export function resolvePolicyScopes(
  scopes: readonly string[],
  values: { runId: string; sessionId?: string }
): string[] {
  return scopes.flatMap((scope) => {
    if (scope.includes(SESSION_SCOPE_PLACEHOLDER) && !values.sessionId) return [];
    return [
      scope
        .replaceAll(RUN_SCOPE_PLACEHOLDER, values.runId)
        .replaceAll(SESSION_SCOPE_PLACEHOLDER, values.sessionId ?? ""),
    ];
  });
}

export function envVarGranted(grant: EnvVarGrant, key: string): boolean {
  return grant === "all" || grant.includes(key);
}

/**
 * True when stored run annotations pin an execution policy (or mark a sandbox run, which must have
 * one). Such a run never reuses a process or VM, including for its own retries.
 */
export function hasPinnedExecutionPolicy(annotations: unknown): boolean {
  if (typeof annotations !== "object" || annotations === null) return false;
  const record = annotations as Record<string, unknown>;
  return record.executionPolicy !== undefined || record.executionMode === "SANDBOX";
}

/** True when stored run annotations mark a run that must never leave microVM compute. */
export function isSandboxRun(annotations: unknown): boolean {
  return (
    typeof annotations === "object" &&
    annotations !== null &&
    (annotations as Record<string, unknown>).executionMode === "SANDBOX"
  );
}
