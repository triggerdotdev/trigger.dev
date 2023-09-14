import { z } from "zod";
import {
  findEnvironmentByApiKey,
  findEnvironmentByPublicApiKey,
} from "~/models/runtimeEnvironment.server";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export type AuthenticatedEnvironment = NonNullable<
  Awaited<ReturnType<typeof findEnvironmentByApiKey>>
>;

type ApiAuthenticationResult = {
  apiKey: string;
  type: "PUBLIC" | "PRIVATE";
  environment: AuthenticatedEnvironment;
};

export async function authenticateApiRequest(
  request: Request,
  { allowPublicKey = false }: { allowPublicKey?: boolean } = {}
): Promise<ApiAuthenticationResult | undefined> {
  const result = getApiKeyFromRequest(request);

  if (!result) {
    return;
  }

  return await authenticateApiKey(result, { allowPublicKey });
}

export async function authenticateApiKey(
  apiKey: string,
  { allowPublicKey = false }: { allowPublicKey?: boolean } = {}
): Promise<ApiAuthenticationResult | undefined> {
  const type = isPublicApiKey(apiKey) ? ("PUBLIC" as const) : ("PRIVATE" as const);

  //if it's a public API key and we don't allow public keys, return
  if (!allowPublicKey) {
    const environment = await findEnvironmentByApiKey(apiKey);
    if (!environment) return;

    return {
      apiKey,
      type,
      environment,
    };
  }

  switch (type) {
    case "PUBLIC": {
      const environment = await findEnvironmentByPublicApiKey(apiKey);
      if (!environment) return;
      return {
        apiKey,
        type,
        environment,
      };
    }
    case "PRIVATE": {
      const environment = await findEnvironmentByApiKey(apiKey);
      if (!environment) return;

      return {
        apiKey,
        type,
        environment,
      };
    }
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

  return apiKey;
}
