import { describe, expect, it } from "vitest";
import { normalizeKeyString } from "../src/v3/webhooks.js";

describe("normalizeKeyString", () => {
  it("passes through webhook./header./body. placeholders unchanged", () => {
    expect(normalizeKeyString("{body.event.id}")).toBe("{body.event.id}");
    expect(normalizeKeyString("{header.x-github-event}")).toBe("{header.x-github-event}");
    expect(normalizeKeyString("{webhook.deliveryId}")).toBe("{webhook.deliveryId}");
  });

  it("defaults an unqualified placeholder to the event body", () => {
    expect(normalizeKeyString("{event.id}")).toBe("{body.event.id}");
    expect(normalizeKeyString("{conversationId}")).toBe("{body.conversationId}");
  });

  it("normalizes every placeholder in a composite template", () => {
    expect(normalizeKeyString("{team}/{body.channel}/{event.ts}")).toBe(
      "{body.team}/{body.channel}/{body.event.ts}"
    );
  });

  it("leaves literal text and unmatched braces alone", () => {
    expect(normalizeKeyString("no-placeholders")).toBe("no-placeholders");
    expect(normalizeKeyString("{{body.x}}")).toBe("{{body.x}}");
  });

  it("handles a pathological brace run in linear time", { timeout: 1000 }, () => {
    const input = "{".repeat(500_000);
    expect(normalizeKeyString(input)).toBe(input);
  });
});
