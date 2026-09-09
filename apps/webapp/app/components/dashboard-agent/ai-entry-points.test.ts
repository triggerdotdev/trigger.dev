import { describe, expect, it } from "vitest";
import { aiShortcutRows } from "./ai-entry-points";

// This proves the decision, not the render: the component maps this list to rows, so a row can
// still be mislabelled — but it can no longer be shown to someone who cannot use it.

describe("aiShortcutRows", () => {
  it("lists the agent's rows only for a reader with access", () => {
    expect(aiShortcutRows({ agent: true })).toEqual([
      "agent-toggle",
      "agent-new-chat",
      "agent-close-chat",
    ]);
    expect(aiShortcutRows({ agent: false })).toEqual([]);
  });
});
