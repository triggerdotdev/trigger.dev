import {
  SignJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
  type JWTPayload,
  type KeyLike,
  type JWTVerifyResult,
} from "jose";
import {
  OIDC_CLOCK_TOLERANCE_SECONDS,
  OIDC_MAX_SUPPORTED_JWT_TTL_SECONDS,
  OIDC_RSA_MODULUS_LENGTH_BITS,
  OIDC_SIGNING_ALGORITHM,
} from "./constants";

export type PublicRs256Jwk = {
  kty: "RSA";
  n: string;
  e: string;
  kid: string;
  use: "sig";
  alg: "RS256";
};

export type PublicJwks = { keys: PublicRs256Jwk[] };

export function parsePublicRs256Jwk(value: unknown): PublicRs256Jwk {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid RSA public JWK");
  }

  const jwk = value as Record<string, unknown>;
  if (
    jwk.kty !== "RSA" ||
    typeof jwk.n !== "string" ||
    !jwk.n ||
    typeof jwk.e !== "string" ||
    !jwk.e ||
    typeof jwk.kid !== "string" ||
    !jwk.kid ||
    jwk.use !== "sig" ||
    jwk.alg !== OIDC_SIGNING_ALGORITHM
  ) {
    throw new Error("Invalid RSA public JWK");
  }

  return {
    kty: "RSA",
    n: jwk.n,
    e: jwk.e,
    kid: jwk.kid,
    use: "sig",
    alg: OIDC_SIGNING_ALGORITHM,
  };
}

export async function generateRs256KeyPair(): Promise<{
  kid: string;
  publicJwk: PublicRs256Jwk;
  privateKeyPkcs8: string;
}> {
  const { privateKey, publicKey } = await generateKeyPair(OIDC_SIGNING_ALGORITHM, {
    modulusLength: OIDC_RSA_MODULUS_LENGTH_BITS,
    extractable: true,
  });
  const exportedPublicKey = await exportJWK(publicKey);

  if (
    exportedPublicKey.kty !== "RSA" ||
    typeof exportedPublicKey.n !== "string" ||
    typeof exportedPublicKey.e !== "string"
  ) {
    throw new Error("Generated key is not an RSA public key");
  }

  const kid = await calculateJwkThumbprint(exportedPublicKey);
  return {
    kid,
    publicJwk: {
      kty: "RSA",
      n: exportedPublicKey.n,
      e: exportedPublicKey.e,
      kid,
      use: "sig",
      alg: OIDC_SIGNING_ALGORITHM,
    },
    privateKeyPkcs8: await exportPKCS8(privateKey),
  };
}

export function importRs256PrivateKey(privateKeyPkcs8: string): Promise<KeyLike> {
  return importPKCS8(privateKeyPkcs8, OIDC_SIGNING_ALGORITHM);
}

export async function signRs256Jwt({
  payload,
  privateKey,
  kid,
  issuer,
  audience,
  subject,
  expiresInSeconds,
  now = new Date(),
}: {
  payload: JWTPayload;
  privateKey: KeyLike;
  kid: string;
  issuer: string;
  audience: string | string[];
  subject: string;
  expiresInSeconds: number;
  now?: Date;
}): Promise<string> {
  if (
    !Number.isInteger(expiresInSeconds) ||
    expiresInSeconds < 1 ||
    expiresInSeconds > OIDC_MAX_SUPPORTED_JWT_TTL_SECONDS
  ) {
    throw new RangeError(
      `JWT lifetime must be between 1 and ${OIDC_MAX_SUPPORTED_JWT_TTL_SECONDS} seconds`
    );
  }

  const issuedAt = Math.floor(now.getTime() / 1000);

  return new SignJWT(payload)
    .setProtectedHeader({ alg: OIDC_SIGNING_ALGORITHM, kid, typ: "JWT" })
    .setIssuer(issuer)
    .setAudience(audience)
    .setSubject(subject)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + expiresInSeconds)
    .sign(privateKey);
}

export async function verifyRs256Jwt<Payload extends JWTPayload = JWTPayload>({
  token,
  jwks,
  issuer,
  audience,
  now = new Date(),
}: {
  token: string;
  jwks: PublicJwks;
  issuer: string;
  audience: string | string[];
  now?: Date;
}): Promise<JWTVerifyResult<Payload>> {
  return jwtVerify<Payload>(token, createLocalJWKSet(jwks), {
    algorithms: [OIDC_SIGNING_ALGORITHM],
    issuer,
    audience,
    requiredClaims: ["exp", "iat", "iss", "aud", "sub"],
    maxTokenAge: OIDC_MAX_SUPPORTED_JWT_TTL_SECONDS,
    clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
    currentDate: now,
  });
}
