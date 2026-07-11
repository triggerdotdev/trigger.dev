import { describe, expect, it } from "vitest";
import { isSameOriginNavigation } from "../app/utils/sameOriginNavigation.js";

const ORIGIN = "https://app.trigger.dev";
const req = (headers: Record<string, string>) =>
  new Request("https://app.trigger.dev/@/orgs/victim/anything", { headers });

// Property under test: only an unambiguously same-origin navigation is
// accepted; anything cross-site is refused.
describe("isSameOriginNavigation", () => {
  it("accepts Sec-Fetch-Site: same-origin", () => {
    expect(isSameOriginNavigation(req({ "sec-fetch-site": "same-origin" }), ORIGIN)).toBe(true);
  });

  it("rejects cross-site / same-site / none Sec-Fetch-Site (the phishing vector)", () => {
    for (const v of ["cross-site", "same-site", "none"]) {
      expect(isSameOriginNavigation(req({ "sec-fetch-site": v }), ORIGIN)).toBe(false);
    }
  });

  it("falls back to a Referer matching the dashboard origin", () => {
    expect(isSameOriginNavigation(req({ referer: "https://app.trigger.dev/runs" }), ORIGIN)).toBe(
      true
    );
  });

  it("rejects a Referer from a different origin", () => {
    expect(isSameOriginNavigation(req({ referer: "https://evil.example.com/x" }), ORIGIN)).toBe(
      false
    );
  });

  it("denies by default when neither Sec-Fetch-Site nor Referer is present", () => {
    expect(isSameOriginNavigation(req({}), ORIGIN)).toBe(false);
  });

  it("rejects an unparseable Referer", () => {
    expect(isSameOriginNavigation(req({ referer: "not a url" }), ORIGIN)).toBe(false);
  });

  it("prefers Sec-Fetch-Site over Referer when both are present", () => {
    // A same-origin Referer must not rescue a cross-site Sec-Fetch-Site.
    expect(
      isSameOriginNavigation(
        req({ "sec-fetch-site": "cross-site", referer: "https://app.trigger.dev/x" }),
        ORIGIN
      )
    ).toBe(false);
  });
});
