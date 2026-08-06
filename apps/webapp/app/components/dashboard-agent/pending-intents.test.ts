import { describe, expect, it } from "vitest";
import { pendingNavigateIntents } from "./pending-intents";

describe("pendingNavigateIntents", () => {
  const uri = "trigger://proj_abc/env_123/run/run_abc";
  const toolPart = (toolCallId: string, state = "output-available") => ({
    type: "tool-navigate_to",
    state,
    toolCallId,
    output: { intent: { kind: "navigate", target: uri } },
  });

  it("returns the intent from a completed navigate_to call, once", () => {
    const seen = new Set<string>();
    const messages = [{ id: "m1", parts: [toolPart("call-1")] }];

    expect(pendingNavigateIntents(messages, seen)).toEqual([{ kind: "navigate", target: uri }]);
    expect(pendingNavigateIntents(messages, seen)).toEqual([]);
  });

  it("ignores a call that hasn't produced output yet", () => {
    expect(
      pendingNavigateIntents(
        [{ id: "m1", parts: [toolPart("call-1", "input-available")] }],
        new Set()
      )
    ).toEqual([]);
  });

  it("ignores output that isn't a navigate intent", () => {
    const messages = [
      { id: "m1", parts: [{ ...toolPart("call-1"), output: { error: "nowhere to go" } }] },
      { id: "m2", parts: [{ type: "text", text: "hello" }] },
    ];

    expect(pendingNavigateIntents(messages, new Set())).toEqual([]);
  });

  it("skips calls seeded as already seen (loaded history)", () => {
    const history = [{ id: "m1", parts: [toolPart("call-1")] }];
    const seen = new Set<string>();
    pendingNavigateIntents(history, seen);

    expect(
      pendingNavigateIntents([...history, { id: "m2", parts: [toolPart("call-2")] }], seen)
    ).toEqual([{ kind: "navigate", target: uri }]);
  });
});
