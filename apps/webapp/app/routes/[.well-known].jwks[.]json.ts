import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { oidcSigningKeyService } from "~/services/oidc/instance.server";
import { OIDC_JWKS_HTTP_MAX_AGE_SECONDS } from "~/services/oidc/constants";

export async function loader({ request }: LoaderFunctionArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (!env.OIDC_ISSUER_URL) {
    return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const jwks = await oidcSigningKeyService.getPublicJwks();
    return json(jwks, {
      headers: {
        "Cache-Control": `public, max-age=${OIDC_JWKS_HTTP_MAX_AGE_SECONDS}`,
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch {
    logger.error("Unable to load OIDC public keys");
    return json(
      { error: "OIDC public keys unavailable" },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
