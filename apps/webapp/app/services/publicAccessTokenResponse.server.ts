import { generateJWT } from "@trigger.dev/core/v3";
import { resolveJwtSigningKey } from "@trigger.dev/rbac";

export type PublicAccessTokenEnvironment = {
  id: string;
  apiKey: string;
  parentEnvironment?: { apiKey: string } | null;
};

export async function publicAccessTokenResponseHeaders({
  environment,
  scopes,
  expirationTime,
}: {
  environment: PublicAccessTokenEnvironment;
  scopes: string[];
  expirationTime: string;
}): Promise<Record<string, string>> {
  const jwt = await generateJWT({
    secretKey: resolveJwtSigningKey(environment),
    payload: {
      sub: environment.id,
      pub: true,
      scopes,
    },
    expirationTime,
  });

  return {
    "x-trigger-jwt-claims": JSON.stringify({ sub: environment.id, pub: true }),
    "x-trigger-jwt": jwt,
  };
}
