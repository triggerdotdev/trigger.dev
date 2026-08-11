import { describe, expect, it } from "vitest";
import {
  checkMessageParts,
  declaredBodyBytes,
  exceedsMessageBodyBytes,
  MAX_MESSAGE_BODY_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGE_PARTS,
} from "./message-limits";

describe("message limits", () => {
  it("lets a long real question through", () => {
    const text = "why did this fail?\n".repeat(50);

    expect(exceedsMessageBodyBytes(Buffer.byteLength(text, "utf8"))).toBe(false);
    expect(checkMessageParts([{ type: "text", text }])).toBeNull();
  });

  it("refuses a pasted dump by bytes", () => {
    expect(exceedsMessageBodyBytes(MAX_MESSAGE_BODY_BYTES)).toBe(false);
    expect(exceedsMessageBodyBytes(MAX_MESSAGE_BODY_BYTES + 1)).toBe(true);
  });

  it("counts multi-byte characters as bytes, not characters", () => {
    // Under the char cap, over the byte cap: 4 bytes each.
    const emoji = "🙂".repeat(MAX_MESSAGE_BODY_BYTES / 4 + 1);

    expect(emoji.length).toBeLessThan(MAX_MESSAGE_BODY_BYTES);
    expect(exceedsMessageBodyBytes(Buffer.byteLength(emoji, "utf8"))).toBe(true);
  });

  it("refuses a dump split across parts", () => {
    const parts = Array.from({ length: 4 }, () => ({
      type: "text",
      text: "x".repeat(MAX_MESSAGE_CHARS / 2),
    }));

    expect(checkMessageParts(parts)).toBe("too_long");
  });

  it("refuses too many parts", () => {
    const parts = Array.from({ length: MAX_MESSAGE_PARTS + 1 }, () => ({
      type: "text",
      text: "x",
    }));

    expect(checkMessageParts(parts)).toBe("too_many_parts");
    expect(checkMessageParts(parts.slice(0, MAX_MESSAGE_PARTS))).toBeNull();
  });

  it("leaves a shape that isn't a parts array to the schema", () => {
    expect(checkMessageParts(undefined)).toBeNull();
    expect(checkMessageParts("nope")).toBeNull();
  });

  it("reads the declared size, or nothing when it isn't declared", () => {
    expect(declaredBodyBytes(new Headers({ "content-length": "1234" }))).toBe(1234);
    expect(declaredBodyBytes(new Headers())).toBeNull();
    expect(declaredBodyBytes(new Headers({ "content-length": "nope" }))).toBeNull();
    // An undeclared size can't be refused here; the body's own length is.
    expect(exceedsMessageBodyBytes(null)).toBe(false);
  });
});
