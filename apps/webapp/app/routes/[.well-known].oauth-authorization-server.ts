import { json } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { authorizationServerMetadata } from "~/services/oauth/metadata.server";

export function loader() {
  if (!env.MCP_SERVER_ENABLED) {
    return new Response(null, { status: 404 });
  }

  return json(authorizationServerMetadata(), {
    headers: { "Cache-Control": "public, max-age=3600", "Access-Control-Allow-Origin": "*" },
  });
}
