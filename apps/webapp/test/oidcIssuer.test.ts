import { describe, expect, it } from "vitest";
import { OidcIssuerSchema, oidcDiscovery } from "~/utils/oidcIssuer";

describe("OIDC issuer configuration", () => {
  // Catches: discovery advertising the shared origin or another organization's JWKS URL.
  it("discovers a distinct issuer and matching JWKS URL for each organization", () => {
    const baseUrl = OidcIssuerSchema.parse("https://issuer.example.com/");
    expect(baseUrl).toBe("https://issuer.example.com");
    for (const organizationSlug of ["acme", "other-org"]) {
      const discovery = oidcDiscovery(baseUrl, organizationSlug);
      expect(discovery.issuer).toBe(`https://issuer.example.com/${organizationSlug}`);
      expect(discovery.jwks_uri).toBe(
        `https://issuer.example.com/${organizationSlug}/.well-known/jwks.json`
      );
    }
  });

  it.each([
    "http://issuer.example.com",
    "https://user:password@issuer.example.com",
    "https://issuer.example.com/tenant",
    "https://issuer.example.com?tenant=a",
    "https://issuer.example.com#tenant",
  ])("rejects an invalid issuer base origin: %s", (issuer) => {
    expect(OidcIssuerSchema.safeParse(issuer).success).toBe(false);
  });
});
