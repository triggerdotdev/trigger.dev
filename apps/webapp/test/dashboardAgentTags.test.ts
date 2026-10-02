import { describe, expect, it } from "vitest";
import { dashboardAgentTags } from "~/services/dashboardAgentTags";

const SCOPE = { organizationSlug: "acme", projectRef: "proj_abc", userId: "user_1" };

describe("dashboard agent tags", () => {
  it("tags a chat by organization, project, environment and user", () => {
    expect(dashboardAgentTags({ ...SCOPE, environmentSlug: "prod" })).toEqual([
      "org:acme",
      "project:proj_abc",
      "env:prod",
      "user:user_1",
    ]);
  });

  it("keeps two long branch slugs with a shared prefix apart, within the limit", () => {
    const shared = "feature-".repeat(20);
    const [alpha] = dashboardAgentTags({ ...SCOPE, environmentSlug: `${shared}alpha` }).filter(
      (tag) => tag.startsWith("env:")
    );
    const [beta] = dashboardAgentTags({ ...SCOPE, environmentSlug: `${shared}beta` }).filter(
      (tag) => tag.startsWith("env:")
    );

    expect(alpha!.length).toBeLessThanOrEqual(128);
    expect(beta!.length).toBeLessThanOrEqual(128);
    expect(alpha).not.toBe(beta);
    expect(dashboardAgentTags({ ...SCOPE, environmentSlug: `${shared}alpha` })).toContain(alpha);
  });
});
