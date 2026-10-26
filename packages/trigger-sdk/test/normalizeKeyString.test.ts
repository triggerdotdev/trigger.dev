import { describe, expect, it } from "vitest";
import { normalizeKeyString } from "../src/v3/webhooks.js";

describe("normalizeKeyString", () => {
  it("stores an event path against the body and passes header./webhook. through", () => {
    expect(normalizeKeyString("{event.data.object.id}")).toBe("{body.data.object.id}");
    expect(normalizeKeyString("{event.event.ts}")).toBe("{body.event.ts}");
    expect(normalizeKeyString("{header.x-github-event}")).toBe("{header.x-github-event}");
    expect(normalizeKeyString("{webhook.deliveryId}")).toBe("{webhook.deliveryId}");
  });

  it("normalizes every placeholder in a composite template", () => {
    expect(normalizeKeyString("{event.team}/{webhook.id}/{event.event.ts}")).toBe(
      "{body.team}/{webhook.id}/{body.event.ts}"
    );
  });

  it("namespaces every alternative in a fallback placeholder", () => {
    expect(normalizeKeyString("{event.a || event.b}")).toBe("{body.a || body.b}");
    expect(normalizeKeyString("{ header.x || event.y }")).toBe("{header.x || body.y}");
  });

  it("refuses a placeholder without a namespace, naming the fix", () => {
    expect(() => normalizeKeyString("{conversationId}")).toThrow(
      'Invalid key "{conversationId}": "{conversationId}" needs a namespace. Use {event.conversationId}'
    );
    expect(() => normalizeKeyString("{body.customer}")).toThrow("Use {event.customer}");
    expect(() => normalizeKeyString("{event.a || b}")).toThrow('"{b}" needs a namespace');
  });

  it("leaves literal text and unmatched braces alone", () => {
    expect(normalizeKeyString("no-placeholders")).toBe("no-placeholders");
    expect(normalizeKeyString("{{event.x}}")).toBe("{{body.x}}");
  });

  it("handles a pathological brace run in linear time", { timeout: 1000 }, () => {
    const input = "{".repeat(500_000);
    expect(normalizeKeyString(input)).toBe(input);
  });
});
