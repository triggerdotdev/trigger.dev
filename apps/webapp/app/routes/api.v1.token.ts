import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type {
  GetPersonalAccessTokenResponse} from "@trigger.dev/core/v3";
import {
  GetPersonalAccessTokenRequestSchema
} from "@trigger.dev/core/v3";
import { generateErrorMessage } from "zod-error";
import { logger } from "~/services/logger.server";
import { getPersonalAccessTokenFromAuthorizationCode } from "~/services/personalAccessToken.server";
import { clientSafeErrorMessage } from "~/utils/prismaErrors";

export async function action({ request }: ActionFunctionArgs) {
  logger.info("Getting PersonalAccessToken from AuthorizationCode", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  //There is no authentication on this endpoint, anyone can create an AuthorizationCode.
  //But only a logged in user can create a PersonalAccessToken, so for a user who can't login to the app this will always fail.

  // Now parse the request body
  const anyBody = await request.json();
  const body = GetPersonalAccessTokenRequestSchema.safeParse(anyBody);
  if (!body.success) {
    return json({ error: generateErrorMessage(body.error.issues) }, { status: 422 });
  }

  try {
    const personalAccessToken = await getPersonalAccessTokenFromAuthorizationCode(
      body.data.authorizationCode
    );

    const responseJson: GetPersonalAccessTokenResponse = {
      token: personalAccessToken.token,
    };
    return json(responseJson);
  } catch (error) {
    if (error instanceof Error) {
      const expected = error.message === "Invalid authorization code, or code expired";
      const fields = { url: request.url, error: error.message };
      if (expected) {
        logger.warn("Error getting PersonalAccessToken from AuthorizationCode", fields);
      } else {
        logger.error("Error getting PersonalAccessToken from AuthorizationCode", fields);
      }

      return json({ error: clientSafeErrorMessage(error) }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 400 });
  }
}
