import { z } from "zod/v4";

export const RUN_SCOPE_PLACEHOLDER = "$run";
/** Internal trigger source marker for sandbox task registration. */
export const SANDBOX_TRIGGER_SOURCE = "sandbox";
export const SESSION_SCOPE_PLACEHOLDER = "$session";

const MAX_GRANTED_ENV_VARS = 256;
const MAX_POLICY_SCOPES = 64;
const SANDBOX_BASELINE_SCOPES = [
  `read:runPayloads:${RUN_SCOPE_PLACEHOLDER}`,
  `write:runOutputs:${RUN_SCOPE_PLACEHOLDER}`,
];

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

/** Normalized sandbox declaration sent in the worker manifest. */
export const SandboxTaskConfig = z.object({
  envVars: EnvVarGrant.optional(),
  scopes: z
    .array(z.string().min(1))
    .max(MAX_POLICY_SCOPES - SANDBOX_BASELINE_SCOPES.length)
    .optional(),
  // Preserves the task's original trigger source.
  triggerSource: z.string().optional(),
});
export type SandboxTaskConfig = z.infer<typeof SandboxTaskConfig>;

export function sandboxExecutionPolicy(config: SandboxTaskConfig): RunExecutionPolicy {
  return {
    version: 1,
    rootKey: false,
    scopes: [...SANDBOX_BASELINE_SCOPES, ...(config.scopes ?? [])],
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

/**
 * Why stored run annotations pin a run to microVM compute: a sandbox run, or a run of a
 * compute-only organization. Such a run is never moved to a container lane. Undefined when the run
 * may move.
 */
export function computeOnlyReason(annotations: unknown): "sandbox" | "compute_only" | undefined {
  if (isSandboxRun(annotations)) return "sandbox";
  if (
    typeof annotations === "object" &&
    annotations !== null &&
    (annotations as Record<string, unknown>).computeOnly === true
  ) {
    return "compute_only";
  }
  return undefined;
}
