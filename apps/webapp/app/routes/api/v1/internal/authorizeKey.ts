import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { findEnvironmentByApiKey } from "~/models/runtimeEnvironment.server";

const AuthorizationHeaderSchema = z.string().regex(/^Bearer .+$/);

// Get the API key from the request headers,
// Then lookup the organization ID from the API key in the RuntimeEnvironment
export async function loader({ request }: LoaderArgs) {
  const rawAuthorization = request.headers.get("Authorization");

  const authorization = AuthorizationHeaderSchema.safeParse(rawAuthorization);

  if (!authorization.success) {
    return json({ error: "Missing or invalid API key" }, { status: 401 });
  }

  const apiKey = authorization.data.replace(/^Bearer /, "");

  const environment = await findEnvironmentByApiKey(apiKey);

  if (!environment) {
    return json({ error: "Invalid API Key" }, { status: 401 });
  }

  return json({
    organizationId: environment.organizationId,
    env: environment.slug,
  });
}
