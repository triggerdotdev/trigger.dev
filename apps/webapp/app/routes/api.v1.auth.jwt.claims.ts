import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

export async function action({ request }: LoaderFunctionArgs) {
  try {
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
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to read auth jwt claims", { error });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
