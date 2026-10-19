import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { OIDC_JWKS_HTTP_MAX_AGE_SECONDS } from "~/services/oidc/constants";
import { oidcDiscovery } from "~/utils/oidcIssuer";

export function loader({ request }: LoaderFunctionArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (!env.OIDC_ISSUER_URL) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  return json(oidcDiscovery(env.OIDC_ISSUER_URL), {
    headers: {
      "Cache-Control": `public, max-age=${OIDC_JWKS_HTTP_MAX_AGE_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
}
