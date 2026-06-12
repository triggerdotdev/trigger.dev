import { describe, expect, it } from "vitest";
import { toSafeUrl } from "~/components/runs/v3/agent/AgentMessageView";

describe("toSafeUrl", () => {
  it("allows http(s) and blob URLs", () => {
    expect(toSafeUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(toSafeUrl("http://example.com/x")).toBe("http://example.com/x");
    expect(toSafeUrl("blob:https://example.com/uuid")).toBe("blob:https://example.com/uuid");
  });

  it("rejects javascript: and other dangerous schemes", () => {
    expect(toSafeUrl("javascript:alert(1)")).toBeNull();
    expect(toSafeUrl("JavaScript:alert(1)")).toBeNull();
    expect(toSafeUrl("vbscript:msgbox(1)")).toBeNull();
    expect(toSafeUrl("file:///etc/passwd")).toBeNull();
  });

  it("rejects data: URLs unless inline images are explicitly allowed", () => {
    const dataImage = "data:image/png;base64,iVBORw0KGgo=";
    expect(toSafeUrl(dataImage)).toBeNull();
    expect(toSafeUrl(dataImage, true)).toBe(dataImage);
    // Only image data is allowed, even in image context — never data:text/html.
    expect(toSafeUrl("data:text/html,<script>alert(1)</script>", true)).toBeNull();
  });

  it("rejects relative URLs and non-string/malformed input", () => {
    expect(toSafeUrl("/relative/path")).toBeNull();
    expect(toSafeUrl("not a url")).toBeNull();
    expect(toSafeUrl(undefined)).toBeNull();
    expect(toSafeUrl(null)).toBeNull();
    expect(toSafeUrl(42)).toBeNull();
  });
});
