import { generateJWT as internal_generateJWT } from "@trigger.dev/core/v3";
import { extractJwtSigningSecretKey } from "./jwtAuth.server";

type Environment = Parameters<typeof extractJwtSigningSecretKey>[0];

export type MintRunTokenOptions = {
  /** Include the input-stream write scope (needed for steering messages from the playground). */
  includeInputStreamWrite?: boolean;
  /** Token expiration. Defaults to "1h". */
  expirationTime?: string;
};

/**
 * Mint a run-scoped public access token (JWT) for browser subscription to a
 * run's realtime streams.
 *
 * Used by:
 * - The playground action to give a freshly triggered chat session a token.
 * - The run details page to let the agent view subscribe to the chat stream
 *   of an existing run (read-only).
 */
export async function mintRunToken(
  environment: Environment,
  runFriendlyId: string,
  options: MintRunTokenOptions = {}
): Promise<string> {
  const scopes = [`read:runs:${runFriendlyId}`];
  if (options.includeInputStreamWrite) {
    scopes.push(`write:inputStreams:${runFriendlyId}`);
  }

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
