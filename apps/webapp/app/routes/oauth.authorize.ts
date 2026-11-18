import { json, redirect, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import {
  assertNotImpersonating,
  authorizationRedirectUrl,
  consentPath,
  createOAuthAuthorizationCode,
  validateAuthorizationRequest,
} from "~/services/oauth/authorize.server";
import { checkOAuthIpRateLimit } from "~/services/oauth/rateLimit.server";
import { requireUser } from "~/services/session.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!env.MCP_SERVER_ENABLED) {
    return new Response(null, { status: 404 });
  }

  const user = await requireUser(request);
  assertNotImpersonating(user);
  const params = new URL(request.url).searchParams;

  const retryAfter = await checkOAuthIpRateLimit("cimd", request);
  if (retryAfter !== null) {
    return json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": retryAfter.toString() } }
    );
  }

  const result = await validateAuthorizationRequest(params);

  if (!result.ok) {
    if (!result.redirect) {
      return json(result.error, { status: 400 });
    }
    return redirect(
      authorizationRedirectUrl(
        result.redirectUri,
        { error: result.error.error, error_description: result.error.error_description },
        result.state
      )
    );
  }

  const code = await createOAuthAuthorizationCode(result.request, user.id);
  return redirect(consentPath(code.code, result.request.state));
}
