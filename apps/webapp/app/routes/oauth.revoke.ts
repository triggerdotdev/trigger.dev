import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { checkOAuthIpRateLimit } from "~/services/oauth/rateLimit.server";
import { revokeToken } from "~/services/oauth/token.server";

export async function action({ request }: ActionFunctionArgs) {
  if (!env.MCP_SERVER_ENABLED) {
    return new Response(null, { status: 404 });
  }

  if (request.method.toUpperCase() !== "POST") {
    return new Response(null, { status: 405 });
  }

  const retryAfter = await checkOAuthIpRateLimit("revoke", request);
  if (retryAfter !== null) {
    return json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": retryAfter.toString() } }
    );
  }

  await revokeToken(new URLSearchParams(await request.text()));
  return new Response(null, { status: 200 });
}
