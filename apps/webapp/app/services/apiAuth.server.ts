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
  { allowPublicKey = false }: { allowPublicKey?: boolean } = {}
): Promise<AuthenticatedEnvironment | null | undefined> {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);
  if (!authorization.success) {
    return;
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");

  if (allowPublicKey) {
    return findEnvironmentByPublicOrPrivateApiKey(apiKey);
  }

  return findEnvironmentByApiKey(apiKey);
}
