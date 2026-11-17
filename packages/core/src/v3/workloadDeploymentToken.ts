import { z } from "zod/v4";
import { generateJWT, validateJWT } from "./jwt.js";

/**
 * Signed token carried in TRIGGER_DEPLOYMENT_ID to identify a run controller. Deployment-scoped
 * by default and run-scoped for sandboxes. Long-lived identity token, not a rotating credential;
 * the `ver` claim allows a future format revision.
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
  execution_mode: z.literal("SANDBOX").optional(),
  run: z.string().optional(),
  exp: z.number(),
});

export type WorkloadDeploymentTokenClaims = z.infer<typeof WorkloadDeploymentTokenClaims>;

/** Claims the caller supplies; `ver` and `exp` are set by the minter. */
export type WorkloadDeploymentTokenInput = Omit<WorkloadDeploymentTokenClaims, "ver" | "exp">;

/**
 * `expiresAtSeconds` is an absolute epoch supplied by the supervisor. Combined with the omitted
 * `iat`, minting is byte-deterministic: identical claims mint identical
 * bytes, so standard runners keep one OTel `worker.id` per deployment. Sandbox tokens also include
 * the run identity.
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
