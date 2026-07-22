import {
  classifyDeploymentIdHeader,
  mintWorkloadDeploymentToken,
  type WorkloadDeploymentTokenClaims,
  type WorkloadDeploymentTokenInput,
} from "@trigger.dev/core/v3";
import { Counter, Gauge } from "prom-client";
import { env } from "./env.js";
import { register } from "./metrics.js";

const secret = env.WORKLOAD_TOKEN_SECRET;

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
export type WorkloadAuthOutcome = "jwt_valid" | "jwt_invalid" | "legacy_bare" | "token_absent";

const verifyCounter = new Counter({
  name: "workload_auth_verify_total",
  help: "Runner-boundary token verification outcomes at the supervisor workload server",
  labelNames: ["outcome", "transport", "env_type"] as const,
  registers: [register],
});

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
  if (!workloadTokensEnabled || !secret) {
    return undefined;
  }

  const token = await mintWorkloadDeploymentToken(claims, secret, tokenExpSeconds);
  mintCounter.inc({ env_type: claims.environment_type });
  return token;
}

export type VerifiedDeploymentHeader =
  | { outcome: "jwt_valid"; claims: WorkloadDeploymentTokenClaims }
  | { outcome: "jwt_invalid" | "legacy_bare" | "token_absent"; claims?: undefined };

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
  });
  return result;
}

async function classify(value: string | undefined): Promise<VerifiedDeploymentHeader> {
  if (!value || !secret) {
    return { outcome: "token_absent" };
  }

  const result = await classifyDeploymentIdHeader(value, secret);

  if (result.outcome === "jwt_valid" && result.claims) {
    return { outcome: "jwt_valid", claims: result.claims };
  }

  return { outcome: result.outcome === "jwt_valid" ? "jwt_invalid" : result.outcome };
}
