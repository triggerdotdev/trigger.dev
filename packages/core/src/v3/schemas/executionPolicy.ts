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

export const MAX_NETWORK_ALLOW_HOSTS = 100;
const HOST_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Lowercase DNS names with at least two labels, optionally `*.` for any subdomain. No IP literals.
const NETWORK_HOST = new RegExp(`^(?:\\*\\.)?(?:${HOST_LABEL}\\.)+${HOST_LABEL}$`);

export function isNetworkAllowHost(host: string): boolean {
  return host.length <= 253 && NETWORK_HOST.test(host) && !/^[0-9.]+$/.test(host);
}

export const NetworkAllowHost = z.string().refine(isNetworkAllowHost, {
  message: 'Expected a lowercase hostname such as "api.example.com" or "*.example.com"',
});

/**
 * Outbound internet access. `"restricted"` allows only Trigger.dev's own services; `allow` adds the
 * listed HTTPS hosts. Hosts of granted proxy-only variables are always reachable through the
 * secret proxy.
 */
export const SandboxNetwork = z.union([
  z.literal("restricted"),
  z.literal("unrestricted"),
  z.object({ allow: z.array(NetworkAllowHost).max(MAX_NETWORK_ALLOW_HOSTS) }).strict(),
]);
export type SandboxNetwork = z.infer<typeof SandboxNetwork>;

/** Stored form: `"restricted"` is `{ allow: [] }`. */
export const RunNetworkPolicy = z.union([
  z.literal("unrestricted"),
  z.object({ allow: z.array(NetworkAllowHost).max(MAX_NETWORK_ALLOW_HOSTS) }).strict(),
]);
export type RunNetworkPolicy = z.infer<typeof RunNetworkPolicy>;

/**
 * What a run may access. Absent means the standard behaviour: root key, admin run token and every
 * environment variable. Scopes may contain `$run` and `$session`, filled in when the token is minted.
 * An absent `network` is restricted, so a reader that drops the field (an older webapp replica or
 * a stale cache entry) fails closed. New sandbox policies always set it.
 */
export const RunExecutionPolicy = z.object({
  version: z.literal(1),
  rootKey: z.boolean(),
  scopes: z.array(z.string().min(1)).max(MAX_POLICY_SCOPES),
  envVars: EnvVarGrant,
  network: RunNetworkPolicy.optional(),
});
export type RunExecutionPolicy = z.infer<typeof RunExecutionPolicy>;

/** Normalized sandbox declaration sent in the worker manifest. */
export const SandboxTaskConfig = z.object({
  envVars: EnvVarGrant.optional(),
  scopes: z
    .array(z.string().min(1))
    .max(MAX_POLICY_SCOPES - SANDBOX_BASELINE_SCOPES.length)
    .optional(),
  network: SandboxNetwork.optional(),
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
    network:
      config.network === undefined || config.network === "restricted"
        ? { allow: [] }
        : config.network,
  };
}

/**
 * The hosts a pinned policy restricts outbound HTTPS to, or undefined when the network is
 * unrestricted. Standard runs (no policy) are unrestricted.
 */
export function restrictedNetwork(
  policy: Pick<RunExecutionPolicy, "network"> | undefined
): { allow: string[] } | undefined {
  if (!policy || policy.network === "unrestricted") return undefined;
  return policy.network ?? { allow: [] };
}

/** True when stored run annotations pin a policy that restricts the network. */
export function hasRestrictedNetwork(annotations: unknown): boolean {
  if (!hasPinnedExecutionPolicy(annotations)) return false;
  const parsed = RunExecutionPolicy.safeParse(
    (annotations as Record<string, unknown>).executionPolicy
  );
  // An unreadable policy fails closed here; attempt start refuses it anyway.
  return !parsed.success || restrictedNetwork(parsed.data) !== undefined;
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
