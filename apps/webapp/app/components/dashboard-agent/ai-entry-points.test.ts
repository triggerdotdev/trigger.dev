import { describe, expect, it } from "vitest";
import { aiMenuEntries, aiShortcutRows } from "./ai-entry-points";

// These prove the decision, not the render: the components map these lists to rows, so a row can
// still be mislabelled — but it can no longer be shown to someone who cannot use it.

describe("aiMenuEntries", () => {
  it("offers the agent and Ask AI when the reader has both", () => {
    expect(aiMenuEntries({ agent: true, askAi: true })).toEqual(["agent", "ask-ai"]);
  });

  it("offers Ask AI on its own where Kapa is configured and the agent is not available", () => {
    expect(aiMenuEntries({ agent: false, askAi: true })).toEqual(["ask-ai"]);
  });

  it("offers the agent on its own where Kapa is not configured", () => {
    expect(aiMenuEntries({ agent: true, askAi: false })).toEqual(["agent"]);
  });

  it("offers nothing when neither surface exists", () => {
    expect(aiMenuEntries({ agent: false, askAi: false })).toEqual([]);
  });
});

describe("aiShortcutRows", () => {
  it("lists ⌘J's row only for a reader with the agent", () => {
    expect(aiShortcutRows({ agent: true, askAi: false })).toContain("agent-toggle");
    expect(aiShortcutRows({ agent: false, askAi: true })).not.toContain("agent-toggle");
  });

  it("lists ⌘I's row wherever Ask AI can open", () => {
    expect(aiShortcutRows({ agent: false, askAi: true })).toContain("ask-ai");
    expect(aiShortcutRows({ agent: true, askAi: true })).toContain("ask-ai");
    expect(aiShortcutRows({ agent: true, askAi: false })).not.toContain("ask-ai");
  });

  it("keeps the chat rows with the agent that owns them", () => {
    expect(aiShortcutRows({ agent: true, askAi: true })).toEqual([
      "agent-toggle",
      "ask-ai",
      "agent-new-chat",
      "agent-close-chat",
    ]);
    expect(aiShortcutRows({ agent: false, askAi: false })).toEqual([]);
  });
});
