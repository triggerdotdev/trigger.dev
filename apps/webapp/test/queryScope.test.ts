import { describe, expect, it } from "vitest";
import { queryScopeCeilingFor, resolveQueryScope } from "~/v3/queryScope";

// The public query API takes `scope` in the request body and executeQuery isolates
// on it, so without this the body — not the credential — decided how much data a
// caller could read.
describe("the query scope ceiling", () => {
  it("caps a public access token at its own environment", () => {
    expect(queryScopeCeilingFor("PUBLIC_JWT")).toBe("environment");
  });

  // `PUBLIC` is the deprecated `pk_*` key: browser-shipped and environment-bound, the same
  // shape of credential a public access token is. Nothing routes it here today, so this is
  // the helper refusing to hand it the organization if anything ever does.
  it("caps a public API key at its own environment", () => {
    expect(queryScopeCeilingFor("PUBLIC")).toBe("environment");
  });

  it("leaves the secret key uncapped", () => {
    expect(queryScopeCeilingFor("PRIVATE")).toBe("unbounded");
  });

  // Compile-time: the fallback is the cap, but a misspelled credential kind must still not
  // be able to name itself into the uncapped branch.
  it("takes only the credential kinds that exist", () => {
    // @ts-expect-error not an authentication type
    expect(() => queryScopeCeilingFor("private")).not.toThrow();
  });
});

describe("resolveQueryScope", () => {
  // An environment token asking to read the whole organization is refused, not
  // quietly narrowed: an org-shaped question answered with one environment's
  // numbers looks like an answer and isn't.
  it("rejects an organization-scoped body from an environment token", () => {
    const decision = resolveQueryScope({ ceiling: "environment", requested: "organization" });
    expect(decision.ok).toBe(false);
    expect(decision.ok === false && decision.error).toContain("scoped to one environment");
  });

  it("rejects a project-scoped body from an environment token", () => {
    expect(resolveQueryScope({ ceiling: "environment", requested: "project" }).ok).toBe(false);
  });

  // The route's body schema defaults `scope` to "environment", so "no scope" and
  // the token's ceiling are the same request.
  it("allows an environment token its own environment", () => {
    expect(resolveQueryScope({ ceiling: "environment", requested: "environment" })).toEqual({
      ok: true,
      scope: "environment",
    });
  });

  // A secret key, a PAT-exchanged session or the Query page still query at org
  // scope: they are not environment-bound credentials.
  it("leaves an uncapped caller's organization scope alone", () => {
    expect(resolveQueryScope({ ceiling: "unbounded", requested: "organization" })).toEqual({
      ok: true,
      scope: "organization",
    });
  });
});
