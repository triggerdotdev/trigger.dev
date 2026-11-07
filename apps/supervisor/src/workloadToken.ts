import {
  mintWorkloadDeploymentToken,
  type WorkloadDeploymentTokenClaims,
  type WorkloadDeploymentTokenInput,
} from "@trigger.dev/core/v3";
import { parseRunId } from "@trigger.dev/core/v3/isomorphic";
import { Counter, Gauge } from "prom-client";
import { env } from "./env.js";
import { register } from "./metrics.js";
import {
  classifyDeploymentIdHeaderWithKeySet,
  mintWorkloadDeploymentTokenEd25519,
  parseWorkloadTokenPublicKeys,
  parseWorkloadTokenSecrets,
  type WorkloadDeploymentTokenKeySet,
} from "./workloadTokenEd25519.js";

const secret = env.WORKLOAD_TOKEN_SECRET;

const signingKey = env.WORKLOAD_TOKEN_SIGNING_KEY;

const publicKeys = parseWorkloadTokenPublicKeys(env.WORKLOAD_TOKEN_PUBLIC_KEYS);

const secrets = parseWorkloadTokenSecrets(env.WORKLOAD_TOKEN_SECRETS);

const previousSecret =
  env.WORKLOAD_TOKEN_SECRET_PREVIOUS && env.WORKLOAD_TOKEN_SECRET_PREVIOUS !== secret
    ? env.WORKLOAD_TOKEN_SECRET_PREVIOUS
    : undefined;

const currentKeySet: WorkloadDeploymentTokenKeySet = {
  publicKeys: publicKeys.filter((entry) => !entry.runCutoff).map((entry) => entry.publicKey),
  hmacSecrets: [
    ...new Set([
      ...(secret ? [secret] : []),
      ...secrets.filter((entry) => !entry.runCutoff).map((entry) => entry.secret),
    ]),
  ],
};

type PreviousKeySet = {
  keySet: WorkloadDeploymentTokenKeySet;
  runCutoffMs: number | undefined;
};

const previousRunCutoffMs = env.WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF
  ? new Date(env.WORKLOAD_TOKEN_PREVIOUS_RUN_CUTOFF).getTime()
  : undefined;

const previousKeySets: PreviousKeySet[] = [
  ...publicKeys
    .filter((entry) => entry.runCutoff)
    .map((entry) => ({
      keySet: { publicKeys: [entry.publicKey], hmacSecrets: [] },
      runCutoffMs: Date.parse(entry.runCutoff!),
    })),
  ...secrets
    .filter((entry) => entry.runCutoff)
    .map((entry) => ({
      keySet: { publicKeys: [], hmacSecrets: [entry.secret] },
      runCutoffMs: Date.parse(entry.runCutoff!),
    })),
  ...(previousSecret
    ? [
        {
          keySet: { publicKeys: [], hmacSecrets: [previousSecret] },
          runCutoffMs: previousRunCutoffMs,
        },
      ]
    : []),
];

const hasCurrentKeys = currentKeySet.publicKeys.length + currentKeySet.hmacSecrets.length > 0;

// Absolute expiry (epoch seconds) shared by every mint, so tokens stay byte-deterministic per
// deployment regardless of when/where a pod is created.
const tokenExpSeconds = Math.floor(new Date(env.WORKLOAD_TOKEN_EXP).getTime() / 1000);

/** Mint + verify run in "log" (dry-run) and "enforce"; the env superRefine guarantees a secret then. */
export const workloadTokensEnabled = env.WORKLOAD_TOKEN_ENFORCEMENT !== "disabled";

/** Only "enforce" rejects a present-but-invalid token; "log" observes and always allows. */
export const workloadTokenEnforced = env.WORKLOAD_TOKEN_ENFORCEMENT === "enforce";

const mintCounter = new Counter({
  name: "workload_token_minted_total",
  help: "Deployment tokens minted and injected into TRIGGER_DEPLOYMENT_ID at pod creation",
  labelNames: ["env_type"] as const,
  registers: [register],
});

export type WorkloadAuthTransport = "http" | "ws";

const verifyCounter = new Counter({
  name: "workload_auth_verify_total",
  help: "Runner-boundary token verification outcomes at the supervisor workload server",
  labelNames: ["outcome", "transport", "env_type", "key"] as const,
  registers: [register],
});

const previousCutoffCounter = new Counter({
  name: "workload_token_previous_cutoff_total",
  help: "Run-creation cutoff checks for requests authenticated with the previous workload token key",
  labelNames: ["result", "mode"] as const,
  registers: [register],
});

const previousCutoffModeGauge = new Gauge({
  name: "workload_token_previous_cutoff_mode",
  help: "Active previous-key cutoff mode: value 1 for the label matching WORKLOAD_TOKEN_PREVIOUS_CUTOFF_MODE",
  labelNames: ["mode"] as const,
  registers: [register],
});
previousCutoffModeGauge.set({ mode: env.WORKLOAD_TOKEN_PREVIOUS_CUTOFF_MODE }, 1);

// Exports the active mode (value 1 for the current WORKLOAD_TOKEN_ENFORCEMENT) so dashboards can show
// disabled/log/enforce at a glance — the counters alone don't distinguish log from enforce.
const enforcementModeGauge = new Gauge({
  name: "workload_token_enforcement_mode",
  help: "Active runner-boundary auth mode: value 1 for the label matching WORKLOAD_TOKEN_ENFORCEMENT",
  labelNames: ["mode"] as const,
  registers: [register],
});
enforcementModeGauge.set({ mode: env.WORKLOAD_TOKEN_ENFORCEMENT }, 1);

export async function mintDeploymentToken(
  claims: WorkloadDeploymentTokenInput
): Promise<string | undefined> {
  if (!workloadTokensEnabled) {
    return undefined;
  }

  if (!signingKey && !secret) {
    throw new Error(
      "Cannot mint a workload deployment token: set WORKLOAD_TOKEN_SIGNING_KEY or WORKLOAD_TOKEN_SECRET"
    );
  }

  const token = signingKey
    ? mintWorkloadDeploymentTokenEd25519(claims, signingKey, tokenExpSeconds)
    : await mintWorkloadDeploymentToken(claims, secret!, tokenExpSeconds);
  mintCounter.inc({ env_type: claims.environment_type });
  return token;
}

export type WorkloadTokenKey = "current" | "previous";

export type VerifiedDeploymentHeader =
  | {
      outcome: "jwt_valid";
      key: WorkloadTokenKey;
      claims: WorkloadDeploymentTokenClaims;
      runCutoffMs?: number;
    }
  | {
      outcome: "jwt_invalid" | "legacy_bare" | "token_absent";
      key?: undefined;
      claims?: undefined;
      runCutoffMs?: undefined;
    };

/**
 * Verify the deployment-id header value and record the outcome. "jwt_valid" returns the claims so the
 * caller can forward the verified environment_id upstream; other outcomes carry no trusted data.
 */
export async function verifyDeploymentIdHeader(
  value: string | undefined,
  transport: WorkloadAuthTransport
): Promise<VerifiedDeploymentHeader> {
  const result = await classify(value);
  verifyCounter.inc({
    outcome: result.outcome,
    transport,
    env_type: result.outcome === "jwt_valid" ? result.claims.environment_type : "unknown",
    key: result.key ?? "none",
  });
  return result;
}

async function classify(value: string | undefined): Promise<VerifiedDeploymentHeader> {
  if (!value || !hasCurrentKeys) {
    return { outcome: "token_absent" };
  }

  const result = await classifyDeploymentIdHeaderWithKeySet(value, currentKeySet);

  if (result.outcome === "jwt_valid" && result.claims) {
    return { outcome: "jwt_valid", key: "current", claims: result.claims };
  }

  if (result.outcome === "legacy_bare") {
    return { outcome: "legacy_bare" };
  }

  for (const { keySet, runCutoffMs } of previousKeySets) {
    const previous = await classifyDeploymentIdHeaderWithKeySet(value, keySet);
    if (previous.outcome === "jwt_valid" && previous.claims) {
      return { outcome: "jwt_valid", key: "previous", claims: previous.claims, runCutoffMs };
    }
  }

  return { outcome: "jwt_invalid" };
}

export type PreviousKeyCutoffResult = "pass" | "fail";

export const previousKeyCutoffMode = env.WORKLOAD_TOKEN_PREVIOUS_CUTOFF_MODE;

export const previousKeyCutoffEnforced = previousKeyCutoffMode === "enforce";

export function checkPreviousKeyRunCutoff(
  runFriendlyId: unknown,
  runCutoffMs: number | undefined
): PreviousKeyCutoffResult {
  const result = previousKeyRunCutoffResult(runFriendlyId, runCutoffMs);
  previousCutoffCounter.inc({ result, mode: previousKeyCutoffMode });
  return result;
}

function previousKeyRunCutoffResult(
  runFriendlyId: unknown,
  runCutoffMs: number | undefined
): PreviousKeyCutoffResult {
  if (typeof runFriendlyId !== "string") {
    return "fail";
  }

  if (runCutoffMs === undefined) {
    return "pass";
  }

  if (!runFriendlyId.startsWith("run_")) {
    return "fail";
  }

  const parsed = parseRunId(runFriendlyId);

  if (parsed.format === "legacy") {
    return "pass";
  }

  return parsed.timestamp.getTime() < runCutoffMs ? "pass" : "fail";
}
