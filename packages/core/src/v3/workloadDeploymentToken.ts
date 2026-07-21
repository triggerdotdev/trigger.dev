import { z } from "zod";
import { generateJWT, validateJWT } from "./jwt.js";

/**
 * Signed, deployment-scoped token carried in the TRIGGER_DEPLOYMENT_ID env var to identify a run
 * controller. Long-lived identity token, not a rotating credential; the `ver` claim allows a future
 * format revision.
 */
export const WORKLOAD_DEPLOYMENT_TOKEN_VERSION = 1 as const;

export const WorkloadDeploymentTokenClaims = z.object({
  ver: z.literal(WORKLOAD_DEPLOYMENT_TOKEN_VERSION),
  /** Deployment friendlyId (deployment_xxxx). */
  deployment: z.string(),
  deployment_version: z.string(),
  environment_id: z.string(),
  environment_type: z.string(),
  org_id: z.string(),
  project_id: z.string(),
  exp: z.number(),
});

export type WorkloadDeploymentTokenClaims = z.infer<typeof WorkloadDeploymentTokenClaims>;

/** Claims the caller supplies; `ver` and `exp` are set by the minter. */
export type WorkloadDeploymentTokenInput = Omit<WorkloadDeploymentTokenClaims, "ver" | "exp">;

/**
 * `expiresAtSeconds` is an absolute epoch (caller-supplied — the supervisor drives it). Combined with
 * the omitted `iat`, the token is byte-deterministic per deployment: identical claims mint identical
 * bytes, so the OTel `worker.id` the runner derives from it stays one value per deployment.
 */
export async function mintWorkloadDeploymentToken(
  claims: WorkloadDeploymentTokenInput,
  secret: string,
  expiresAtSeconds: number
): Promise<string> {
  return generateJWT({
    secretKey: secret,
    payload: { ver: WORKLOAD_DEPLOYMENT_TOKEN_VERSION, ...claims },
    expirationTime: expiresAtSeconds,
    omitIssuedAt: true,
  });
}

export type WorkloadDeploymentTokenVerification =
  | { ok: true; claims: WorkloadDeploymentTokenClaims }
  | { ok: false; reason: "invalid_signature" | "malformed_claims"; error: string };

export async function verifyWorkloadDeploymentToken(
  token: string,
  secret: string
): Promise<WorkloadDeploymentTokenVerification> {
  const result = await validateJWT(token, secret);

  if (!result.ok) {
    return { ok: false, reason: "invalid_signature", error: result.error };
  }

  const parsed = WorkloadDeploymentTokenClaims.safeParse(result.payload);

  if (!parsed.success) {
    return { ok: false, reason: "malformed_claims", error: parsed.error.message };
  }

  return { ok: true, claims: parsed.data };
}

/**
 * A legacy TRIGGER_DEPLOYMENT_ID is a bare friendlyId (deployment_xxxx); a minted token is a JWT of
 * three non-empty base64url segments. Used by the dry-run to tell a pre-upgrade runner from a token.
 */
export function looksLikeWorkloadDeploymentToken(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

export type DeploymentIdHeaderOutcome = "jwt_valid" | "jwt_invalid" | "legacy_bare";

/**
 * Classify the value carried in the deployment-id header for the rollout metric, verifying the
 * signature when it is JWT-shaped. Returns the claims on a valid token so callers avoid a second verify.
 */
export async function classifyDeploymentIdHeader(
  value: string,
  secret: string
): Promise<{ outcome: DeploymentIdHeaderOutcome; claims?: WorkloadDeploymentTokenClaims }> {
  if (!looksLikeWorkloadDeploymentToken(value)) {
    return { outcome: "legacy_bare" };
  }

  const result = await verifyWorkloadDeploymentToken(value, secret);

  if (result.ok) {
    return { outcome: "jwt_valid", claims: result.claims };
  }

  return { outcome: "jwt_invalid" };
}
