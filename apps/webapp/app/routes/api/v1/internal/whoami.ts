import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";

// Get the API key from the request headers,
// Then lookup the organization ID from the API key in the RuntimeEnvironment
export async function loader({ request }: LoaderArgs) {
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  return json({
    organizationId: authenticatedEnv.organizationId,
    env: authenticatedEnv.slug,
    organizationSlug: authenticatedEnv.organization.slug,
  });
}
