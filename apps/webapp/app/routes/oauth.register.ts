import { json, type ActionFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { registerClient } from "~/services/oauth/clients.server";
import { oauthError } from "~/services/oauth/metadata.server";
import { checkOAuthIpRateLimit } from "~/services/oauth/rateLimit.server";

export async function action({ request }: ActionFunctionArgs) {
  if (!env.MCP_SERVER_ENABLED) {
    return new Response(null, { status: 404 });
  }

  if (request.method.toUpperCase() !== "POST") {
    return json(oauthError("invalid_request", "POST required"), { status: 405 });
  }

  const retryAfter = await checkOAuthIpRateLimit("register", request);
  if (retryAfter !== null) {
    return json(
      { error: "too_many_requests" },
      { status: 429, headers: { "Retry-After": retryAfter.toString() } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(oauthError("invalid_client_metadata", "Invalid JSON body"), { status: 400 });
  }

  const result = await registerClient(body);
  return json(result.body, { status: result.ok ? result.status : 400 });
}
