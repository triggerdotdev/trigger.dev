import { describe, expect, it } from "vitest";
import { pendingNavigateIntents, pendingWatchIntents } from "./pending-intents";

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

describe("pendingWatchIntents", () => {
  const spec = {
    kind: "run_finished",
    runId: "run_abc",
    checkEveryMinutes: 1,
    maxHours: 2,
    note: "tell me when the receipt run finishes",
  };
  const toolPart = (toolCallId: string, state = "output-available") => ({
    type: "tool-schedule_watch",
    state,
    toolCallId,
    output: { intent: { kind: "watch", spec } },
  });

  it("returns the proposed spec from a completed schedule_watch call, once", () => {
    const seen = new Set<string>();
    const messages = [{ id: "m1", parts: [toolPart("call-1")] }];

    expect(pendingWatchIntents(messages, seen)).toEqual([{ kind: "watch", spec }]);
    expect(pendingWatchIntents(messages, seen)).toEqual([]);
  });

  it("ignores a call still running, and a spec the contract rejects", () => {
    expect(
      pendingWatchIntents([{ id: "m1", parts: [toolPart("call-1", "input-available")] }], new Set())
    ).toEqual([]);

    const invalid = [
      {
        id: "m1",
        parts: [
          {
            ...toolPart("call-2"),
            output: { intent: { kind: "watch", spec: { kind: "run_finished" } } },
          },
        ],
      },
    ];
    expect(pendingWatchIntents(invalid, new Set())).toEqual([]);
  });

  it("never reopens a proposal seeded from loaded history", () => {
    const history = [{ id: "m1", parts: [toolPart("call-1")] }];
    const seen = new Set<string>();
    pendingWatchIntents(history, seen);

    expect(pendingWatchIntents(history, seen)).toEqual([]);
    expect(
      pendingWatchIntents([...history, { id: "m2", parts: [toolPart("call-2")] }], seen)
    ).toEqual([{ kind: "watch", spec }]);
  });

  it("doesn't confuse a navigate result for a watch", () => {
    const messages = [
      {
        id: "m1",
        parts: [
          {
            type: "tool-navigate_to",
            state: "output-available",
            toolCallId: "call-1",
            output: { intent: { kind: "navigate", target: "trigger://p/e/run/run_abc" } },
          },
        ],
      },
    ];

    expect(pendingWatchIntents(messages, new Set())).toEqual([]);
  });
});
