import { describe, expect, it } from "vitest";
import { sanitizeGitHubSettingsRedirect } from "~/v3/github/githubSettingsRedirect.server";

const APPLICATION_ORIGIN = "https://dashboard.example.com";

describe("sanitizeGitHubSettingsRedirect", () => {
  it.each([
    "/orgs/example/projects/demo/env/prod/settings/integrations",
    "/orgs/example/projects/demo/env/prod/settings/integrations?origin=marketplace&next=value#github",
  ])("preserves a navigable relative dashboard URL", (redirectUrl) => {
    expect(sanitizeGitHubSettingsRedirect(redirectUrl, APPLICATION_ORIGIN)).toBe(redirectUrl);
  });

  it("converts a same-origin absolute URL to a relative dashboard URL", () => {
    expect(
      sanitizeGitHubSettingsRedirect(
        "https://dashboard.example.com/orgs/example/settings?tab=integrations#github",
        APPLICATION_ORIGIN
      )
    ).toBe("/orgs/example/settings?tab=integrations#github");
  });

  it.each([
    "https://vercel.com/integrations/example/new?configurationId=123",
    "https://marketplace.vercel.com/integrations/example#complete",
  ])("preserves a credential-free HTTPS Vercel URL", (redirectUrl) => {
    expect(sanitizeGitHubSettingsRedirect(redirectUrl, APPLICATION_ORIGIN)).toBe(redirectUrl);
  });

  it.each([
    "https://example.com/steal",
    "https://vercel.com.example.com/steal",
    "https://evilvercel.com/steal",
    "http://vercel.com/steal",
    "https://user:password@vercel.com/steal",
    "https://vercel.com:8443/steal",
    "//vercel.com/steal",
    "/\\vercel.com/steal",
    "/resources/private",
    "not a URL",
  ])("rejects an unsafe return destination: %s", (redirectUrl) => {
    expect(sanitizeGitHubSettingsRedirect(redirectUrl, APPLICATION_ORIGIN)).toBeUndefined();
  });

  it("does not trust an origin or marketplace marker in the query", () => {
    expect(
      sanitizeGitHubSettingsRedirect(
        "/orgs/example/settings?origin=marketplace&next=https%3A%2F%2Fevil.example",
        APPLICATION_ORIGIN
      )
    ).toBe("/orgs/example/settings?origin=marketplace&next=https%3A%2F%2Fevil.example");
  });
});
