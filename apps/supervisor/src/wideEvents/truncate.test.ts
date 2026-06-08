import { describe, it, expect } from "vitest";
import { truncateUtf8 } from "./truncate.js";

describe("truncateUtf8", () => {
  it("returns short ASCII unchanged", () => {
    expect(truncateUtf8("hello", 512)).toBe("hello");
  });

  it("truncates ASCII to the byte cap", () => {
    expect(truncateUtf8("x".repeat(1024), 256)).toBe("x".repeat(256));
  });

  it("never exceeds the byte cap for multibyte input", () => {
    // "あ" is 3 UTF-8 bytes; 200 of them = 600 bytes.
    const got = truncateUtf8("あ".repeat(200), 256);
    expect(Buffer.byteLength(got, "utf8")).toBeLessThanOrEqual(256);
  });

  it("does not split a multibyte sequence", () => {
    // 256 / 3 bytes = 85 whole chars (255 bytes), the 86th would overflow.
    expect(truncateUtf8("あ".repeat(200), 256)).toBe("あ".repeat(85));
  });

  it("does not split a surrogate pair", () => {
    // "😀" is 2 UTF-16 units / 4 UTF-8 bytes; only one fits under a 5-byte cap.
    const got = truncateUtf8("😀😀", 5);
    expect(got).toBe("😀");
    expect(Buffer.byteLength(got, "utf8")).toBe(4);
  });
});
