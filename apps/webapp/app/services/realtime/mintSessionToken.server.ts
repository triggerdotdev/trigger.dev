import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { extractJwtSigningSecretKey } from "./jwtAuth.server";

type Environment = Parameters<typeof extractJwtSigningSecretKey>[0];

export type MintSessionTokenOptions = {
  /** Token expiration. Defaults to "1h". */
  expirationTime?: string;
};

/**
 * Mint a session-scoped public access token (JWT) covering both `.in`
 * append and `.out` subscribe for a session's realtime channels.
 *
 * Returned by `POST /api/v1/sessions` so the browser holds a single
 * long-lived token that survives across runs (sessions outlive any
 * single run). Includes both read and write scopes since the transport
 * needs both: read for SSE subscribe on `.out`, write for `.in` appends
 * (`stop`, follow-up messages, action chunks).
 */
export async function mintSessionToken(
  environment: Environment,
  sessionAddressingKey: string,
  options: MintSessionTokenOptions = {}
): Promise<string> {
  const scopes = [
    `read:sessions:${sessionAddressingKey}`,
    `write:sessions:${sessionAddressingKey}`,
  ];

  return internal_generateJWT({
    secretKey: extractJwtSigningSecretKey(environment),
    payload: {
      sub: environment.id,
      pub: true,
      scopes,
    },
    expirationTime: options.expirationTime ?? "1h",
  });
}
