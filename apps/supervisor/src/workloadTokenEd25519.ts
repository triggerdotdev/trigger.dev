import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import {
  JWT_AUDIENCE,
  JWT_ISSUER,
  looksLikeWorkloadDeploymentToken,
  verifyWorkloadDeploymentToken,
  WORKLOAD_DEPLOYMENT_TOKEN_VERSION,
  WorkloadDeploymentTokenClaims,
  type DeploymentIdHeaderOutcome,
  type WorkloadDeploymentTokenInput,
  type WorkloadDeploymentTokenVerification,
} from "@trigger.dev/core/v3";
import { z } from "zod";

const PUBLIC_KEY_PEM_BEGIN = "-----BEGIN PUBLIC KEY-----";
const ED25519_SIGNATURE_BYTES = 64;

const WorkloadTokenPublicKeyEntry = z
  .object({
    publicKey: z
      .string()
      .trim()
      .min(1)
      .refine((value) => value.startsWith(PUBLIC_KEY_PEM_BEGIN), {
        message: `publicKey must start with ${PUBLIC_KEY_PEM_BEGIN}`,
      }),
    runCutoff: z.string().datetime().optional(),
  })
  .strict();

type WorkloadTokenPublicKey = z.infer<typeof WorkloadTokenPublicKeyEntry>;

export function parseWorkloadTokenPublicKeys(raw: string | undefined): WorkloadTokenPublicKey[] {
  if (!raw || raw.trim() === "") {
    return [];
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("WORKLOAD_TOKEN_PUBLIC_KEYS must be valid JSON");
  }

  const parsed = z.array(WorkloadTokenPublicKeyEntry).safeParse(json);
  if (!parsed.success) {
    throw new Error(`WORKLOAD_TOKEN_PUBLIC_KEYS is invalid: ${parsed.error.message}`);
  }

  return parsed.data;
}

type WorkloadTokenSecret = { secret: string; runCutoff?: string };

const WorkloadTokenSecretCutoff = z.string().datetime();

export function parseWorkloadTokenSecrets(raw: string | undefined): WorkloadTokenSecret[] {
  if (!raw || raw.trim() === "") {
    return [];
  }

  return raw.split(",").map((part) => {
    const entry = part.trim();
    if (entry === "") {
      throw new Error("WORKLOAD_TOKEN_SECRETS must not contain empty entries");
    }

    const separator = entry.indexOf(":");
    if (separator === -1) {
      return { secret: entry };
    }

    const secret = entry.slice(0, separator).trim();
    if (secret === "") {
      throw new Error("WORKLOAD_TOKEN_SECRETS entries must have a non-empty secret");
    }

    const runCutoff = entry.slice(separator + 1).trim();
    if (!WorkloadTokenSecretCutoff.safeParse(runCutoff).success) {
      throw new Error("WORKLOAD_TOKEN_SECRETS cutoff must be an ISO 8601 datetime");
    }

    return { secret, runCutoff };
  });
}

export function mintWorkloadDeploymentTokenEd25519(
  claims: WorkloadDeploymentTokenInput,
  privateKeyPem: string,
  expiresAtSeconds: number
): string {
  const header = { alg: "EdDSA", typ: "JWT" };
  const payload = {
    ver: WORKLOAD_DEPLOYMENT_TOKEN_VERSION,
    ...claims,
    iss: JWT_ISSUER,
    aud: JWT_AUDIENCE,
    exp: expiresAtSeconds,
  };

  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = sign(null, Buffer.from(signingInput), createPrivateKey(privateKeyPem));

  return `${signingInput}.${signature.toString("base64url")}`;
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function invalid(
  reason: "invalid_signature" | "malformed_claims",
  error: string
): WorkloadDeploymentTokenVerification {
  return { ok: false, reason, error };
}

function verifyWorkloadDeploymentTokenEd25519(
  token: string,
  publicKeyPem: string
): WorkloadDeploymentTokenVerification {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return invalid("invalid_signature", "malformed token");
  }

  const [headerB64, payloadB64, signatureB64] = parts;
  if (!headerB64 || !payloadB64 || !signatureB64) {
    return invalid("invalid_signature", "malformed token");
  }

  let header: unknown;
  try {
    header = JSON.parse(Buffer.from(headerB64, "base64url").toString("utf8"));
  } catch {
    return invalid("invalid_signature", "malformed token header");
  }

  if (
    typeof header !== "object" ||
    header === null ||
    (header as { alg?: unknown }).alg !== "EdDSA"
  ) {
    return invalid("invalid_signature", "unexpected token algorithm");
  }

  const signature = Buffer.from(signatureB64, "base64url");
  if (signature.length !== ED25519_SIGNATURE_BYTES) {
    return invalid("invalid_signature", "bad signature");
  }

  let signatureValid: boolean;
  try {
    const publicKey = createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return invalid("invalid_signature", "public key is not an Ed25519 key");
    }
    signatureValid = verify(null, Buffer.from(`${headerB64}.${payloadB64}`), publicKey, signature);
  } catch {
    return invalid("invalid_signature", "bad signature");
  }

  if (!signatureValid) {
    return invalid("invalid_signature", "bad signature");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return invalid("malformed_claims", "malformed token payload");
  }

  if (typeof payload !== "object" || payload === null) {
    return invalid("malformed_claims", "malformed token payload");
  }

  const { exp, iss, aud } = payload as { exp?: unknown; iss?: unknown; aud?: unknown };

  if (typeof exp !== "number" || exp <= Math.floor(Date.now() / 1000)) {
    return invalid("invalid_signature", "token expired");
  }

  if (iss !== JWT_ISSUER) {
    return invalid("invalid_signature", "bad issuer");
  }

  const audienceOk = Array.isArray(aud) ? aud.includes(JWT_AUDIENCE) : aud === JWT_AUDIENCE;
  if (!audienceOk) {
    return invalid("invalid_signature", "bad audience");
  }

  const parsed = WorkloadDeploymentTokenClaims.safeParse(payload);
  if (!parsed.success) {
    return invalid("malformed_claims", parsed.error.message);
  }

  return { ok: true, claims: parsed.data };
}

export type WorkloadDeploymentTokenKeySet = {
  publicKeys: string[];
  hmacSecrets: string[];
};

export type WorkloadDeploymentTokenKeyMatch = {
  kind: "public_key" | "hmac_secret";
  index: number;
};

export type WorkloadDeploymentTokenKeySetVerification =
  | {
      ok: true;
      claims: WorkloadDeploymentTokenClaims;
      match: WorkloadDeploymentTokenKeyMatch;
    }
  | { ok: false; reason: "invalid_signature" | "malformed_claims"; error: string };

export async function verifyWorkloadDeploymentTokenWithKeySet(
  token: string,
  keySet: WorkloadDeploymentTokenKeySet
): Promise<WorkloadDeploymentTokenKeySetVerification> {
  for (const [index, publicKeyPem] of keySet.publicKeys.entries()) {
    const result = verifyWorkloadDeploymentTokenEd25519(token, publicKeyPem);

    if (result.ok) {
      return { ok: true, claims: result.claims, match: { kind: "public_key", index } };
    }

    if (result.reason === "malformed_claims") {
      return result;
    }
  }

  for (const [index, secret] of keySet.hmacSecrets.entries()) {
    const result = await verifyWorkloadDeploymentToken(token, secret);

    if (result.ok) {
      return { ok: true, claims: result.claims, match: { kind: "hmac_secret", index } };
    }

    if (result.reason === "malformed_claims") {
      return result;
    }
  }

  return { ok: false, reason: "invalid_signature", error: "no configured key verified the token" };
}

export async function classifyDeploymentIdHeaderWithKeySet(
  value: string,
  keySet: WorkloadDeploymentTokenKeySet
): Promise<{
  outcome: DeploymentIdHeaderOutcome;
  claims?: WorkloadDeploymentTokenClaims;
  match?: WorkloadDeploymentTokenKeyMatch;
}> {
  if (!looksLikeWorkloadDeploymentToken(value)) {
    return { outcome: "legacy_bare" };
  }

  const result = await verifyWorkloadDeploymentTokenWithKeySet(value, keySet);

  if (result.ok) {
    return { outcome: "jwt_valid", claims: result.claims, match: result.match };
  }

  return { outcome: "jwt_invalid" };
}
