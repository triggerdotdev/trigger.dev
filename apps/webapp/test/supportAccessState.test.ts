import { describe, expect, it } from "vitest";
import { supportAccessState } from "~/components/admin/supportAccessState";

describe("supportAccessState", () => {
  // Catches: the admin lists offering a request dialog for an organization the policy forces open.
  it("allows an organization the policy forces open", () => {
    expect(
      supportAccessState({
        supportAccessMode: "REQUIRES_REQUEST",
        supportAccessRequests: [],
        supportAccessForced: true,
      })
    ).toBe("allow");
  });

  it("still requires a request otherwise", () => {
    expect(
      supportAccessState({
        supportAccessMode: "REQUIRES_REQUEST",
        supportAccessRequests: [],
        supportAccessForced: false,
      })
    ).toBe("request");
  });
});
