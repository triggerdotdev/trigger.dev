import { z } from "zod";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export function getApiKeyFromRequest(request: Request) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");
  const type = isPublicApiKey(apiKey) ? ("PUBLIC" as const) : ("PRIVATE" as const);
  return { apiKey, type };
}

function isPublicApiKey(key: string) {
  return key.startsWith("pk_");
}
