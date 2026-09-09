import { describe, expect, it } from "vitest";
import { scopeMatchesPath, sessionPathFor } from "./agent-scope";

const scope = {
  organization: { slug: "acme" },
  project: { slug: "api" },
  environment: { slug: "dev" },
};

describe("sessionPathFor", () => {
  it("addresses the project and environment it is given", () => {
    expect(sessionPathFor(scope.organization, scope.project, scope.environment)).toBe(
      "/resources/orgs/acme/projects/api/env/dev/dashboard-agent"
    );
  });

  it("moves with the project, so a path and its client data cannot disagree", () => {
    expect(sessionPathFor(scope.organization, { slug: "web" }, scope.environment)).toBe(
      "/resources/orgs/acme/projects/web/env/dev/dashboard-agent"
    );
  });
});

describe("scopeMatchesPath", () => {
  const sessionPath = sessionPathFor(scope.organization, scope.project, scope.environment);

  it("matches the page the scope belongs to", () => {
    expect(scopeMatchesPath("/orgs/acme/projects/api/env/dev/runs", sessionPath)).toBe(true);
  });

  it("refuses a page that has moved on to another project", () => {
    expect(scopeMatchesPath("/orgs/acme/projects/web/env/dev/runs", sessionPath)).toBe(false);
  });

  it("refuses a page that has moved on to another environment", () => {
    expect(scopeMatchesPath("/orgs/acme/projects/api/env/prod", sessionPath)).toBe(false);
  });

  it("leaves pages without an environment alone", () => {
    expect(scopeMatchesPath("/account/security", sessionPath)).toBe(true);
    expect(scopeMatchesPath("/orgs/acme/settings", sessionPath)).toBe(true);
  });
});
