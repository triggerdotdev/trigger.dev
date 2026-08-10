import { describe, expect, it } from "vitest";
import { restrictModelUrls } from "./StreamdownRenderer";

// streamdown calls urlTransform(url, key, node) to compute each url attribute; a
// returned undefined removes the attribute, so no request is ever issued.
const img = { tagName: "img" } as any;
const link = { tagName: "a" } as any;

describe("restrictModelUrls (image src)", () => {
  it("drops a remote model-authored image (the favicon beacon)", () => {
    expect(
      restrictModelUrls("https://www.google.com/s2/favicons?domain=evil", "src", img)
    ).toBeUndefined();
  });

  it("drops any absolute or protocol-relative remote image", () => {
    expect(restrictModelUrls("http://evil.tld/pixel.gif", "src", img)).toBeUndefined();
    expect(restrictModelUrls("//evil.tld/pixel.gif", "src", img)).toBeUndefined();
  });

  it("keeps inline and same-origin images", () => {
    expect(restrictModelUrls("data:image/png;base64,AAAA", "src", img)).toBe(
      "data:image/png;base64,AAAA"
    );
    expect(restrictModelUrls("blob:abc", "src", img)).toBe("blob:abc");
    expect(restrictModelUrls("/local/pic.png", "src", img)).toBe("/local/pic.png");
  });
});

describe("restrictModelUrls (link href)", () => {
  it("keeps http(s), mailto and relative links", () => {
    expect(restrictModelUrls("https://trigger.dev/docs", "href", link)).toBe(
      "https://trigger.dev/docs"
    );
    expect(restrictModelUrls("http://example.com", "href", link)).toBe("http://example.com");
    expect(restrictModelUrls("mailto:hi@trigger.dev", "href", link)).toBe("mailto:hi@trigger.dev");
    expect(restrictModelUrls("/runs/123", "href", link)).toBe("/runs/123");
  });

  it("drops unsafe link schemes", () => {
    expect(restrictModelUrls("javascript:alert(1)", "href", link)).toBeUndefined();
    expect(restrictModelUrls("data:text/html,<script>", "href", link)).toBeUndefined();
  });
});
