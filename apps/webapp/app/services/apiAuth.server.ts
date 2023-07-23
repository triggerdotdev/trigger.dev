import { z } from "zod";
import {
  findEnvironmentByApiKey,
  findEnvironmentByPublicOrPrivateApiKey,
} from "~/models/runtimeEnvironment.server";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

export type AuthenticatedEnvironment = NonNullable<
  Awaited<ReturnType<typeof findEnvironmentByApiKey>>
>;

export async function authenticateApiRequest(
  request: Request,
  { allowClient = false }: { allowClient?: boolean } = {}
): Promise<AuthenticatedEnvironment | null | undefined> {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");

  if (allowClient) {
    return findEnvironmentByPublicOrPrivateApiKey(apiKey);
  }

  return findEnvironmentByApiKey(apiKey);
}
