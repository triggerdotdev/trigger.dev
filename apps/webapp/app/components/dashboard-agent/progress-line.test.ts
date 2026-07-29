import { describe, expect, it } from "vitest";
import { hasToolProgressLine } from "./progress-line";

describe("hasToolProgressLine", () => {
  it("is true while the last turn has a tool call in flight", () => {
    expect(
      hasToolProgressLine([
        { role: "user", parts: [{ type: "text", text: "how are the queues?" }] },
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Let me look." },
            { type: "tool-render_view", state: "input-available" },
          ],
        },
      ])
    ).toBe(true);
  });

  it("is false once the tool call has output", () => {
    expect(
      hasToolProgressLine([
        { role: "assistant", parts: [{ type: "tool-render_view", state: "output-available" }] },
      ])
    ).toBe(false);
  });

  it("is false for a text-only turn, an empty transcript, and a user last message", () => {
    expect(hasToolProgressLine([])).toBe(false);
    expect(
      hasToolProgressLine([{ role: "assistant", parts: [{ type: "text", text: "hi" }] }])
    ).toBe(false);
    expect(hasToolProgressLine([{ role: "user", parts: [{ type: "text", text: "hi" }] }])).toBe(
      false
    );
  });
});
