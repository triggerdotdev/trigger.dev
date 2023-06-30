import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";

export async function loader({ request }: LoaderArgs) {
  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  return json(authenticatedEnv);
}
