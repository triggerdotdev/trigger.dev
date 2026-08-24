import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chatHistoryTriggerLabel } from "./header-labels";

describe("chatHistoryTriggerLabel", () => {
  it("starts with the words on the button, so speech input can activate it", () => {
    const title = "Why did my task retry?";
    const label = chatHistoryTriggerLabel(title);
    expect(label.startsWith(title)).toBe(true);
    expect(label).toContain(title);
  });

  it("still says what the button does", () => {
    expect(chatHistoryTriggerLabel("New chat").toLowerCase()).toContain("chat history");
  });

  it("falls back to the purpose when there is no title to read", () => {
    expect(chatHistoryTriggerLabel("")).toBe("Chat history");
    expect(chatHistoryTriggerLabel("   ")).toBe("Chat history");
  });
});

/**
 * Structural guard, not behavioural proof: the webapp has no DOM test environment, so nothing
 * here computes a real accessible name. It asserts the header asks for the label above rather
 * than a constant that would replace the visible title.
 */
describe("the header's history trigger", () => {
  const source = readFileSync(new URL("./DashboardAgentHeader.tsx", import.meta.url), "utf8");

  it("names itself with the title, not with a bare constant", () => {
    expect(source).toContain("aria-label={chatHistoryTriggerLabel(title)}");
    expect(source).not.toContain('aria-label="Chat history"');
  });
});
