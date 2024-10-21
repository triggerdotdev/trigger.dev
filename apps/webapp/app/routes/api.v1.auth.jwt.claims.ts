import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";

export async function action({ request }: LoaderFunctionArgs) {
  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const claims = {
    sub: authenticationResult.environment.id,
    pub: true,
  };

  return json(claims);
}
