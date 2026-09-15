import { describe, expect, it } from "vitest";
import { sanitizeHttpUrl } from "../app/utils/sanitizeUrl.js";

// sanitizeHttpUrl returns undefined for anything that isn't http(s), so callers
// fall back to a safe default rather than rendering it into an href.
describe("sanitizeHttpUrl", () => {
  it("passes through http and https URLs", () => {
    expect(sanitizeHttpUrl("https://trigger.dev/changelog")).toBe("https://trigger.dev/changelog");
    expect(sanitizeHttpUrl("http://example.com/x?y=1")).toBe("http://example.com/x?y=1");
  });

  it("rejects script-bearing and non-http(s) schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "javascript:alert(document.cookie)//",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(sanitizeHttpUrl(url)).toBeUndefined();
    }
  });

  it("returns undefined for empty / nullish input", () => {
    expect(sanitizeHttpUrl(undefined)).toBeUndefined();
    expect(sanitizeHttpUrl(null)).toBeUndefined();
    expect(sanitizeHttpUrl("")).toBeUndefined();
  });

  it("returns undefined for unparseable input", () => {
    expect(sanitizeHttpUrl("not a url")).toBeUndefined();
  });
});
