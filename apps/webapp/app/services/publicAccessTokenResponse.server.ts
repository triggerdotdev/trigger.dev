import { generateJWT } from "@trigger.dev/core/v3";
import { resolveJwtSigningKey } from "@trigger.dev/rbac";
import { publicTokenSubject } from "~/services/publicTokenSubject.server";

/** The request's delegation actor (`ApiAuthenticationResultSuccess["actor"]`). */
export type RequestActor = { sub: string; client?: string; pat?: string };

/**
 * The `act` claim for a public token minted on behalf of a request. When the request was
 * authenticated by a JWT exchanged from a PAT, the new token names the same (sealed) source PAT,
 * so it ends with the PAT like its parent does. Only the PAT carries over, not the user: these
 * tokens are often handed to a browser. Otherwise nothing is added.
 */
export function inheritedSourcePatClaim(actor: RequestActor | undefined): {
  act?: { pat: string };
} {
  return actor?.pat ? { act: { pat: actor.pat } } : {};
}

export type PublicAccessTokenEnvironment = {
  id: string;
  apiKey: string;
  parentEnvironment?: { apiKey: string } | null;
};

export async function publicAccessTokenResponseHeaders({
  environment,
  scopes,
  expirationTime,
  actor,
}: {
  environment: PublicAccessTokenEnvironment;
  scopes: string[];
  expirationTime: string;
  actor?: RequestActor;
}): Promise<Record<string, string>> {
  const jwt = await generateJWT({
    secretKey: resolveJwtSigningKey(environment),
    payload: {
      sub: publicTokenSubject(environment.id),
      pub: true,
      scopes,
      ...inheritedSourcePatClaim(actor),
    },
    expirationTime,
  });

  return {
    "x-trigger-jwt-claims": JSON.stringify({ sub: publicTokenSubject(environment.id), pub: true }),
    "x-trigger-jwt": jwt,
  };
}
