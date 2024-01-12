import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { createAuthorizationCode } from "~/services/personalAccessToken.server";

export async function action({ request }: ActionFunctionArgs) {
  logger.info("Creating AuthorizationCode", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  //there is no authentication on this endpoint, anyone can create an AuthorizationCode.
  //they're only used to allow a user to login, when they'll then receive a Personal Access Token

  try {
    const authorizationCode = await createAuthorizationCode();

    return json({
      authorizationCode: authorizationCode.code,
      url: `${env.APP_ORIGIN}/account/authorization-code/${authorizationCode.code}`,
    });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating AuthorizationCode", {
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
