import { describe, expect, it } from "vitest";
import {
  earliestInFlightToolCall,
  hasUnfinishedTextPart,
  inFlightToolName,
  liveInvestigation,
  liveProgress,
} from "./progress-line";

function assistant(parts: unknown[]) {
  return { role: "assistant", parts };
}

function pendingTool(name: string, callId = name) {
  return { type: `tool-${name}`, state: "input-available", toolCallId: callId };
}

function settledTool(name: string, callId = name) {
  return { type: `tool-${name}`, state: "output-available", toolCallId: callId };
}

function investigationPart(
  id: string,
  revision: number,
  outcome: string,
  progress?: string
): unknown {
  return {
    type: "tool-render_view",
    state: "output-available",
    output: {
      blocks: [{ type: "investigation", id, revision, investigation: { outcome, progress } }],
    },
  };
}

describe("inFlightToolName", () => {
  it("names the tool the last turn is waiting on", () => {
    expect(
      inFlightToolName([
        { role: "user", parts: [{ type: "text", text: "how are the queues?" }] },
        assistant([{ type: "text", text: "Let me look." }, pendingTool("get_queue")]),
      ])
    ).toBe("get_queue");
  });

  it("takes the most recent call when two are in flight", () => {
    expect(inFlightToolName([assistant([pendingTool("get_run"), pendingTool("run_query")])])).toBe(
      "run_query"
    );
  });

  it("is null once the call has output, and for a turn with nothing in flight", () => {
    expect(
      inFlightToolName([assistant([{ type: "tool-render_view", state: "output-available" }])])
    ).toBeNull();
    expect(inFlightToolName([])).toBeNull();
    expect(inFlightToolName([assistant([{ type: "text", text: "hi" }])])).toBeNull();
    expect(inFlightToolName([{ role: "user", parts: [{ type: "text", text: "hi" }] }])).toBeNull();
  });

  it("ignores a call left in flight in an earlier turn", () => {
    expect(
      inFlightToolName([
        assistant([pendingTool("get_run")]),
        { role: "user", parts: [{ type: "text", text: "never mind" }] },
      ])
    ).toBeNull();
  });
});

describe("earliestInFlightToolCall", () => {
  it("returns the earliest pending call in emission order", () => {
    expect(
      earliestInFlightToolCall([assistant([pendingTool("get_run"), pendingTool("run_query")])])
    ).toEqual({ callId: "get_run", name: "get_run" });
  });

  it("distinguishes two parallel calls to the same tool by call id, not name", () => {
    expect(
      earliestInFlightToolCall([
        assistant([pendingTool("get_run", "call_1"), pendingTool("get_run", "call_2")]),
      ])
    ).toEqual({ callId: "call_1", name: "get_run" });
  });

  it("is undefined once nothing is in flight", () => {
    expect(earliestInFlightToolCall([assistant([settledTool("get_run")])])).toBeUndefined();
    expect(earliestInFlightToolCall([])).toBeUndefined();
  });

  it("counts an empty-string call id as present — only a missing id is skipped", () => {
    expect(earliestInFlightToolCall([assistant([pendingTool("get_run", "")])])).toEqual({
      callId: "",
      name: "get_run",
    });
    expect(
      earliestInFlightToolCall([assistant([{ type: "tool-get_run", state: "input-available" }])])
    ).toBeUndefined();
  });
});

describe("liveInvestigation", () => {
  it("finds an unfinished card", () => {
    expect(
      liveInvestigation([assistant([investigationPart("inv_1", 0, "in_progress", "Reading logs")])])
    ).toEqual({ progress: "Reading logs" });
  });

  it("is null once a later revision of the same investigation concludes", () => {
    expect(
      liveInvestigation([
        assistant([investigationPart("inv_1", 0, "in_progress", "Reading logs")]),
        assistant([investigationPart("inv_1", 1, "concluded")]),
      ])
    ).toBeNull();
  });

  it("stays live when the concluded revision is the OLDER one", () => {
    expect(
      liveInvestigation([
        assistant([investigationPart("inv_1", 2, "in_progress", "Testing hypothesis 2")]),
        assistant([investigationPart("inv_1", 1, "concluded")]),
      ])
    ).toEqual({ progress: "Testing hypothesis 2" });
  });

  it("follows the investigation the reader saw last", () => {
    expect(
      liveInvestigation([
        assistant([investigationPart("inv_1", 0, "in_progress", "First")]),
        assistant([investigationPart("inv_2", 0, "in_progress", "Second")]),
      ])
    ).toEqual({ progress: "Second" });
  });

  it("reports a card with no progress phrase of its own", () => {
    expect(liveInvestigation([assistant([investigationPart("inv_1", 0, "in_progress")])])).toEqual({
      progress: null,
    });
  });
});

describe("liveProgress", () => {
  it("shows nothing when nothing is in flight", () => {
    expect(liveProgress([assistant([{ type: "text", text: "done" }])], null)).toBeNull();
  });

  it("falls back to the generic activity label", () => {
    expect(liveProgress([], "thinking")).toEqual({ source: "activity", label: "Thinking…" });
    expect(liveProgress([assistant([{ type: "text", text: "…" }])], "working")).toEqual({
      source: "activity",
      label: "Working…",
    });
  });

  it.each([
    ["a known tool, over the generic activity", "get_queue", "Reading the queue…"],
    ["an unknown tool, without a label of its own", "brand_new_tool", "Running brand_new_tool…"],
  ])("prefers a tool's phrase — %s", (_name, tool, label) => {
    expect(liveProgress([assistant([pendingTool(tool)])], "working")).toEqual({
      source: "tool",
      label,
    });
  });

  it("prefers the live card's own phrase over both", () => {
    expect(
      liveProgress(
        [
          assistant([investigationPart("inv_1", 0, "in_progress", "Testing hypothesis 2")]),
          assistant([pendingTool("run_query")]),
        ],
        "working"
      )
    ).toEqual({ source: "investigation", label: "Testing hypothesis 2" });
  });

  it("gives a phrase-less live card the generic wording", () => {
    expect(liveProgress([assistant([investigationPart("inv_1", 0, "in_progress")])], null)).toEqual(
      {
        source: "investigation",
        label: "Working…",
      }
    );
  });

  it("stays non-null through a whole turn: activity → tool → card → tool → done", () => {
    const submitted: unknown[] = [{ role: "user", parts: [{ type: "text", text: "why failed?" }] }];

    const phases = [
      { messages: submitted, activity: "thinking" as const },
      {
        messages: [...submitted, assistant([pendingTool("get_run")])],
        activity: "working" as const,
      },
      // The tool landed; the model is composing prose.
      {
        messages: [
          ...submitted,
          assistant([
            { type: "tool-get_run", state: "output-available" },
            { type: "text", text: "Looking" },
          ]),
        ],
        activity: "working" as const,
      },
      {
        messages: [
          ...submitted,
          assistant([investigationPart("inv_1", 0, "in_progress", "Testing hypothesis 1")]),
        ],
        activity: "working" as const,
      },
      // Another tool runs under the live card.
      {
        messages: [
          ...submitted,
          assistant([investigationPart("inv_1", 0, "in_progress", "Testing hypothesis 1")]),
          assistant([pendingTool("run_query")]),
        ],
        activity: "working" as const,
      },
      // A revision with a new phrase.
      {
        messages: [
          ...submitted,
          assistant([investigationPart("inv_1", 1, "in_progress", "Testing hypothesis 2")]),
        ],
        activity: "working" as const,
      },
    ];

    const results = phases.map(({ messages, activity }) => liveProgress(messages, activity));

    expect(results.every((result) => result !== null)).toBe(true);
    expect(results.map((result) => result!.label)).toEqual([
      "Thinking…",
      "Reading the run…",
      "Working…",
      "Testing hypothesis 1",
      "Testing hypothesis 1",
      "Testing hypothesis 2",
    ]);
    expect(results.map((result) => result!.source)).toEqual([
      "activity",
      "tool",
      "activity",
      "investigation",
      "investigation",
      "investigation",
    ]);

    // The verdict lands and the activity signal drops.
    expect(
      liveProgress([...submitted, assistant([investigationPart("inv_1", 2, "concluded")])], null)
    ).toBeNull();
  });
});

/**
 * A watch wake, the investigation it triggers and a settlement card are all appended
 * after the answer they follow, and all carry `role: "assistant"`. Reading the literal
 * last message would hide the call a hang deadline is timing, and let a dead turn look
 * finished.
 */
describe("in-flight detection behind a trailing agent record", () => {
  const ask = { id: "msg_user", role: "user", parts: [{ type: "text", text: "why?" }] };
  const answering = { id: "msg_answer", ...assistant([pendingTool("run_query")]) };
  const answered = { id: "msg_answer", ...assistant([settledTool("run_query")]) };
  const streaming = {
    id: "msg_answer",
    ...assistant([{ type: "text", text: "Looking", state: "streaming" }]),
  };
  const wake = {
    id: "wake:watch:watch_1:fired",
    ...assistant([{ type: "text", text: "Your watch fired." }]),
  };
  const investigation = {
    id: "investigate:watch:watch_1:fired",
    ...assistant([{ type: "text", text: "Looking into it." }]),
  };
  const turnFailed = {
    id: "turn-error:2",
    ...assistant([{ type: "text", text: "That turn failed." }]),
  };

  it("still finds the pending call when a wake lands on top of it", () => {
    expect(earliestInFlightToolCall([ask, answering, wake])).toEqual({
      callId: "run_query",
      name: "run_query",
    });
    expect(inFlightToolName([ask, answering, wake])).toBe("run_query");
  });

  it("finds it behind a whole watch investigation, not just one record", () => {
    expect(earliestInFlightToolCall([ask, answering, wake, investigation])).toEqual({
      callId: "run_query",
      name: "run_query",
    });
  });

  it("finds nothing once that turn's call has settled", () => {
    expect(earliestInFlightToolCall([ask, answered, wake])).toBeUndefined();
    expect(inFlightToolName([ask, answered, wake])).toBeNull();
  });

  it("does not reach back past the turn boundary into an older turn", () => {
    expect(earliestInFlightToolCall([ask, answering, ask, answered])).toBeUndefined();
  });

  it("stops at a stored failure: that turn ended and nothing is pending", () => {
    expect(earliestInFlightToolCall([ask, answering, turnFailed])).toBeUndefined();
  });

  it("reads streaming text behind a wake as still in flight", () => {
    expect(hasUnfinishedTextPart([ask, streaming, wake])).toBe(true);
    expect(hasUnfinishedTextPart([ask, answered, wake])).toBe(false);
  });

  it("keeps the progress line up while a wake lands mid-turn", () => {
    expect(liveProgress([ask, answering, wake], "working")).toEqual({
      source: "tool",
      label: "Running a query…",
    });
  });
});
