import { organizationSupportPath } from "~/utils/pathBuilder";
import { expect, it } from "vitest";

it("builds the org support settings path", () => {
  expect(organizationSupportPath({ slug: "acme-1234" })).toBe("/orgs/acme-1234/settings/support");
});
