import { z } from "zod";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export function getApiKeyFromRequest(request: Request) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");
  const type = isPrivateApiKey(apiKey) ? ("PRIVATE" as const) : ("PUBLIC" as const);
  return { apiKey, type };
}

function isPrivateApiKey(key: string) {
  return key.startsWith("tr_");
}
