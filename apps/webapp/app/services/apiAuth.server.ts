import { z } from "zod";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

type AuthenticateApiRequestResponse = Awaited<
  ReturnType<typeof findEnvironmentByApiKey>
>;

export async function authenticateApiRequest(
  request: Request
): Promise<AuthenticateApiRequestResponse | undefined> {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);

  if (!authorization.success) {
    return;
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");

  const environment = await findEnvironmentByApiKey(apiKey);

  return environment;
}
