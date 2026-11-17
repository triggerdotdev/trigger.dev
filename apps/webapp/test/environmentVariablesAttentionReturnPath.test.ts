import { describe, expect, it } from "vitest";
import { attentionReturnPath } from "~/v3/environmentVariables/attention";

const params = { organizationSlug: "acme", projectParam: "app-1a2b", envParam: "prod" };
const page = "/orgs/acme/projects/app-1a2b/env/prod/environment-variables/attention";

describe("attentionReturnPath", () => {
  // Catches: a list, compare or create action posted from anywhere else being sent to the page.
  it("is undefined for a request that didn't come from the needs attention page", () => {
    expect(
      attentionReturnPath(
        "https://cloud.trigger.dev/orgs/acme/projects/app-1a2b/env/prod/environment-variables?env=prod",
        params
      )
    ).toBeUndefined();
  });

  it("returns to the same view, and to the key panel when one was open", () => {
    expect(
      attentionReturnPath(`https://cloud.trigger.dev${page}?env=prod&kind=empty&other=x`, params)
    ).toBe(`${page}?env=prod&kind=empty`);
    expect(
      attentionReturnPath(
        `https://cloud.trigger.dev${page}/key/A?kind=missing&branchSearch=x`,
        params,
        "A/B"
      )
    ).toBe(`${page}/key/A%2FB?kind=missing&branchSearch=x`);
  });

  // Catches: the redirect's base taken from the request path, which React Router matches with
  // its leading slashes collapsed, so `//host/...` would become a protocol-relative redirect.
  it("builds the path from the route params, never from the request's path", () => {
    const steered = attentionReturnPath(`https://cloud.trigger.dev/${page}?kind=empty`, params);
    expect(steered).toBe(`${page}?kind=empty`);
    expect(steered?.startsWith("//")).toBe(false);
  });
});
