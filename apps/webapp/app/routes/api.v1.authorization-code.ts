import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { CreateAuthorizationCodeResponse } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import {
  AuthorizationCodeRateLimitError,
  checkAuthorizationCodeMintRateLimit,
} from "~/services/authCodeRateLimiter.server";
import { createAuthorizationCode } from "~/services/personalAccessToken.server";
import { extractClientIp } from "~/utils/extractClientIp.server";

/** Used to create an AuthorizationCode, that can then be used to obtain a Personal Access Token by logging in with the provided URL */
export async function action({ request }: ActionFunctionArgs) {
  logger.info("Creating AuthorizationCode", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  //this endpoint is unauthenticated (codes only allow a user to log in), so it's
  //rate-limited per client IP. Keyed by X-Forwarded-For; if there's no trustworthy
  //client IP we skip the limit rather than bucket everyone together. Self-hosters
  //wanting per-IP limiting should front the app with a proxy that sets X-Forwarded-For.
  const clientIp = extractClientIp(request.headers.get("x-forwarded-for"));
  if (clientIp) {
    try {
      await checkAuthorizationCodeMintRateLimit(clientIp);
    } catch (error) {
      if (error instanceof AuthorizationCodeRateLimitError) {
        return json(
          { error: "Too many requests, please try again later." },
          { status: 429, headers: { "Retry-After": Math.ceil(error.retryAfter / 1000).toString() } }
        );
      }
      throw error;
    }
  }

  try {
    const authorizationCode = await createAuthorizationCode();
    const responseJson: CreateAuthorizationCodeResponse = {
      authorizationCode: authorizationCode.code,
      url: `${env.APP_ORIGIN}/account/authorization-code/${authorizationCode.code}`,
    };

    return json(responseJson);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating AuthorizationCode", {
        url: request.url,
        error: error.message,
      });

      return json({ error: "Failed to create authorization code" }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
