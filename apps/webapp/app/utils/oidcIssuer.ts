import { z } from "zod";

export const OidcIssuerSchema = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  }, "OIDC_ISSUER_URL must be an HTTPS origin without credentials, a path, query or fragment")
  .transform((value) => new URL(value).origin);

export function oidcDiscovery(issuer: string) {
  return {
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    claims_supported: ["aud", "iat", "iss", "sub", "exp"],
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
  };
}
