import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { oauthError } from "~/services/oauth/metadata.server";
import { exchangeAuthorizationCode, exchangeRefreshToken } from "~/services/oauth/token.server";
import { checkOAuthIpRateLimit } from "~/services/oauth/rateLimit.server";
import { extractClientIp } from "~/utils/extractClientIp.server";

const noStore = { "Cache-Control": "no-store", Pragma: "no-cache" };

export async function action({ request }: ActionFunctionArgs) {
  if (!env.MCP_SERVER_ENABLED) {
    return new Response(null, { status: 404 });
  }

  if (request.method.toUpperCase() !== "POST") {
    return json(oauthError("invalid_request", "POST required"), { status: 405, headers: noStore });
  }

  const retryAfter = await checkOAuthIpRateLimit("token", request);
  if (retryAfter !== null) {
    return json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": retryAfter.toString() } }
    );
  }

  const params = new URLSearchParams(await request.text());
  const grantType = params.get("grant_type");

  const result =
    grantType === "authorization_code"
      ? await exchangeAuthorizationCode(params, {
          ip: extractClientIp(request.headers.get("x-forwarded-for")),
          userAgent: request.headers.get("user-agent"),
        })
      : grantType === "refresh_token"
        ? await exchangeRefreshToken(params)
        : {
            ok: false as const,
            body: oauthError("unsupported_grant_type", "Unsupported grant_type"),
          };

  return json(result.body, { status: result.ok ? 200 : 400, headers: noStore });
}
