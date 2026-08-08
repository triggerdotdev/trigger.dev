import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkMessageParts,
  declaredBodyBytes,
  exceedsMessageBodyBytes,
  MAX_MESSAGE_BODY_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGE_PARTS,
  MESSAGE_CHARS_WARN_AT,
  messageCountAnnouncement,
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

describe("messageCountAnnouncement", () => {
  it("says nothing at all for a normal message", () => {
    expect(messageCountAnnouncement(0)).toBe("");
    expect(messageCountAnnouncement(MESSAGE_CHARS_WARN_AT - 1)).toBe("");
  });

  it("reads the count out from the warning point on", () => {
    expect(messageCountAnnouncement(MESSAGE_CHARS_WARN_AT)).toBe(
      `${MESSAGE_CHARS_WARN_AT} / ${MAX_MESSAGE_CHARS}`
    );
    expect(messageCountAnnouncement(MAX_MESSAGE_CHARS)).toBe(
      `${MAX_MESSAGE_CHARS} / ${MAX_MESSAGE_CHARS}`
    );
  });
});

/**
 * Structural guard, not behavioural proof: the webapp has no DOM test environment, so nothing
 * here mounts the composer or listens to a screen reader. It asserts the live region is written
 * unconditionally, which is the part the announcement depends on.
 */
describe("the composer's live region", () => {
  const source = readFileSync(new URL("./DashboardAgentComposer.tsx", import.meta.url), "utf8");

  it("is in the DOM before the count reaches the warning point", () => {
    const region = source.slice(source.indexOf('aria-live="polite"'));
    expect(region).toContain("messageCountAnnouncement(value.length)");
    // The old form: the region itself only existed past the threshold.
    expect(source).not.toMatch(/MESSAGE_CHARS_WARN_AT \? \(\s*<p[^>]*aria-live/);
  });

  it("does not read the visible counter out a second time", () => {
    expect(source).toContain("aria-hidden");
  });
});
