import { describe, expect, it } from "vitest";
import { OidcIssuerSchema, oidcDiscovery } from "./oidcIssuer";

describe("OIDC issuer configuration", () => {
  it("uses one canonical issuer and its own JWKS URL", () => {
    const issuer = OidcIssuerSchema.parse("https://issuer.example.com/");
    expect(issuer).toBe("https://issuer.example.com");
    const discovery = oidcDiscovery(issuer);
    expect(discovery.jwks_uri).toBe("https://issuer.example.com/.well-known/jwks.json");
    expect(discovery.claims_supported).toEqual(
      expect.arrayContaining(["aud", "iat", "iss", "sub", "exp"])
    );
  });

  it.each([
    "http://issuer.example.com",
    "https://user:password@issuer.example.com",
    "https://issuer.example.com/tenant",
    "https://issuer.example.com?tenant=a",
    "https://issuer.example.com#tenant",
  ])("rejects an issuer the root well-known routes cannot safely serve: %s", (issuer) => {
    expect(OidcIssuerSchema.safeParse(issuer).success).toBe(false);
  });
});
