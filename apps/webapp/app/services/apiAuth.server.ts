import { z } from "zod";
import {
  findEnvironmentByApiKey,
  findEnvironmentByPublicApiKey,
} from "~/models/runtimeEnvironment.server";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export type AuthenticatedEnvironment = NonNullable<
  Awaited<ReturnType<typeof findEnvironmentByApiKey>>
>;

export async function authenticateApiRequest(
  request: Request,
  { allowPublicKey = false }: { allowPublicKey?: boolean } = {}
): Promise<AuthenticatedEnvironment | null | undefined> {
  const result = getApiKeyFromRequest(request);

  if (!result) {
    return;
  }

  //if it's a public API key and we don't allow public keys, return
  if (!allowPublicKey) {
    return findEnvironmentByApiKey(result.apiKey);
  }

  switch (result.type) {
    case "PUBLIC":
      return findEnvironmentByPublicApiKey(result.apiKey);
    case "PRIVATE":
      return findEnvironmentByApiKey(result.apiKey);
  }
}

export function isPublicApiKey(key: string) {
  return key.startsWith("pk_");
}

export function getApiKeyFromRequest(request: Request) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");
  const type = isPublicApiKey(apiKey)
    ? ("PUBLIC" as const)
    : ("PRIVATE" as const);
  return { apiKey, type };
}
