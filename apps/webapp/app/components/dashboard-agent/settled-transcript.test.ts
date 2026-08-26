import { VIEW_BLOCK_VERSION } from "@internal/dashboard-agent-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { liveProgress } from "./progress-line";
import {
  fetchChatTranscript,
  hasOpenInvestigation,
  mergeSettledMessages,
  pollSettledTranscript,
  transcriptLooksUnfinished,
} from "./settled-transcript";

/**
 * The open panel. A settled turn writes its terminal card to the chat row rather than
 * pushing a stream chunk, so a panel that stays mounted has to re-read the transcript
 * or it renders the last `in_progress` revision forever.
 */

const INVESTIGATION_ID = "inv_open_panel";

function cardMessage(args: { id: string; revision: number; outcome: string; progress?: string }) {
  return {
    id: args.id,
    role: "assistant",
    parts: [
      {
        type: "tool-render_view",
        toolCallId: args.id,
        state: "output-available",
        output: {
          blocks: [
            {
              type: "investigation",
              id: INVESTIGATION_ID,
              revision: args.revision,
              version: VIEW_BLOCK_VERSION,
              investigation: { outcome: args.outcome, progress: args.progress },
            },
          ],
        },
      },
    ],
  };
}

const OPEN = cardMessage({
  id: "msg_open",
  revision: 0,
  outcome: "in_progress",
  progress: "Reading the run's spans",
});

const SETTLED = cardMessage({
  id: `investigation-settlement:${INVESTIGATION_ID}:1`,
  revision: 1,
  outcome: "inconclusive",
});

describe("merging a re-read transcript", () => {
  it("adds only what the panel doesn't have, keeping what is already rendered in place", () => {
    const merged = mergeSettledMessages([OPEN], [OPEN, SETTLED]);
    expect(merged.map((message) => message.id)).toEqual([OPEN.id, SETTLED.id]);
    expect(merged[0]).toBe(OPEN);
  });

  it("cannot produce a second copy of a card, however many times it re-reads", () => {
    let merged = mergeSettledMessages([OPEN], [OPEN, SETTLED]);
    merged = mergeSettledMessages(merged, [OPEN, SETTLED]);
    merged = mergeSettledMessages(merged, [OPEN, SETTLED]);
    expect(merged.filter((message) => message.id === SETTLED.id)).toHaveLength(1);
  });

  it("returns the same array when the re-read adds nothing, so no render is forced", () => {
    const current = [OPEN, SETTLED];
    expect(mergeSettledMessages(current, [OPEN, SETTLED])).toBe(current);
  });
});

describe("replacing a stale running step from the re-read", () => {
  // Same message id, but the stream EOF'd before `get_report` produced an output.
  const RUNNING_STEP = {
    id: "msg_step",
    role: "assistant",
    parts: [{ type: "tool-get_report", toolCallId: "call_1", state: "input-available" }],
  };

  const FINISHED_STEP = {
    id: "msg_step",
    role: "assistant",
    parts: [
      { type: "tool-get_report", toolCallId: "call_1", state: "output-available", output: {} },
    ],
  };

  it("swaps the still-running copy for its finished version from the authoritative read", () => {
    const merged = mergeSettledMessages([RUNNING_STEP], [FINISHED_STEP]);
    expect(merged).toEqual([FINISHED_STEP]);
    // The step no longer reads as running, so nothing keeps the panel on Working…
    expect(transcriptLooksUnfinished(merged)).toBe(false);
  });

  it("still appends genuinely-new messages while replacing a stale one", () => {
    const merged = mergeSettledMessages([RUNNING_STEP], [FINISHED_STEP, SETTLED]);
    expect(merged.map((message) => message.id)).toEqual([FINISHED_STEP.id, SETTLED.id]);
    expect(merged[0]).toBe(FINISHED_STEP);
  });

  it("leaves an in-flight message alone when the re-read is itself still running", () => {
    const merged = mergeSettledMessages([RUNNING_STEP], [RUNNING_STEP]);
    // Same reference back, no needless render, and the live turn is untouched.
    expect(merged).toEqual([RUNNING_STEP]);
    expect(merged[0]).toBe(RUNNING_STEP);
  });

  it("does not touch a running message the re-read does not mention", () => {
    const merged = mergeSettledMessages([RUNNING_STEP], [SETTLED]);
    expect(merged.map((message) => message.id)).toEqual([RUNNING_STEP.id, SETTLED.id]);
    expect(merged[0]).toBe(RUNNING_STEP);
  });
});

describe("reading the transcript endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function respondWith(body: unknown, ok = true) {
    vi.stubGlobal("fetch", async () => ({ ok, json: async () => body }) as unknown as Response);
  }

  it("returns the transcript when the response carries one", async () => {
    respondWith({ messages: [OPEN, SETTLED] });
    const fetched = await fetchChatTranscript<typeof OPEN>("/agent/transcript", "chat_1");
    expect(fetched?.map((message) => message.id)).toEqual([OPEN.id, SETTLED.id]);
  });

  it("reads a response with no messages at all as a failed re-read", async () => {
    respondWith({});
    expect(await fetchChatTranscript("/agent/transcript", "chat_1")).toBeNull();
  });

  it("reads a non-array under messages as a failed re-read, not as a transcript", async () => {
    respondWith({ messages: { msg_open: OPEN } });
    expect(await fetchChatTranscript("/agent/transcript", "chat_1")).toBeNull();
  });

  it("keeps only entries the merge can key on", async () => {
    respondWith({ messages: [OPEN, null, "msg_open", { revision: 1 }, SETTLED] });
    const fetched = await fetchChatTranscript<typeof OPEN>("/agent/transcript", "chat_1");
    expect(fetched?.map((message) => message.id)).toEqual([OPEN.id, SETTLED.id]);
  });

  it("leaves the panel's transcript alone when the endpoint answers with a shape it cannot merge", async () => {
    respondWith({ messages: { msg_open: OPEN } });
    let rendered: (typeof OPEN)[] = [OPEN];

    await pollSettledTranscript<typeof OPEN>({
      fetchTranscript: () => fetchChatTranscript("/agent/transcript", "chat_1"),
      apply: (merge) => void (rendered = merge(rendered)),
      wait: async () => {},
    });

    expect(rendered).toEqual([OPEN]);
  });
});

describe("deciding whether a settled turn is worth re-reading", () => {
  // The stream EOF'd while `get_report` was running: the part never gets an output.
  const DANGLING_TOOL = {
    id: "msg_dangling",
    role: "assistant",
    parts: [{ type: "tool-get_report", toolCallId: "call_1", state: "input-available" }],
  };

  // A prose-only reply: no tool part to catch, just a `text` part still streaming.
  const DANGLING_TEXT = {
    id: "msg_dangling_text",
    role: "assistant",
    parts: [{ type: "text", text: "Concurrency on the ", state: "streaming" }],
  };

  it("re-reads when the stream died mid-tool, not only when a card is open", () => {
    expect(transcriptLooksUnfinished([DANGLING_TOOL])).toBe(true);
  });

  it("re-reads when the stream died mid-text, with no tool part at all", () => {
    expect(transcriptLooksUnfinished([DANGLING_TEXT])).toBe(true);
  });

  it("leaves a finished text part alone", () => {
    const finished = { ...DANGLING_TEXT, parts: [{ type: "text", text: "Done.", state: "done" }] };
    expect(transcriptLooksUnfinished([finished])).toBe(false);
  });

  it("re-reads while a card is still open", () => {
    expect(transcriptLooksUnfinished([OPEN])).toBe(true);
  });

  it("leaves a fully settled transcript alone", () => {
    expect(transcriptLooksUnfinished([OPEN, SETTLED])).toBe(false);
  });
});

describe("an already-open panel when a turn is exhausted", () => {
  it("stops showing Working… without a reload or a reopen", async () => {
    // What the mounted panel holds when the stream closes: the card the model opened
    // and never concluded, and no turn in flight.
    let rendered: (typeof OPEN)[] = [OPEN];
    expect(liveProgress(rendered, null)).toEqual({
      source: "investigation",
      label: "Reading the run's spans",
    });

    // The stored transcript, which `onTurnComplete` has closed out by now.
    const waits: number[] = [];
    await pollSettledTranscript({
      fetchTranscript: async () => [OPEN, SETTLED],
      apply: (merge) => void (rendered = merge(rendered)),
      wait: async (ms) => void waits.push(ms),
    });

    expect(rendered.map((message) => message.id)).toEqual([OPEN.id, SETTLED.id]);
    // The panel's own progress line is gone: the winning revision is terminal.
    expect(liveProgress(rendered, null)).toBeNull();
    // One re-read was enough, because the transcript came back closed.
    expect(waits).toHaveLength(1);
  });

  it("retries while the stored transcript is still open, because the write lands after the stream closes", async () => {
    const responses = [[OPEN], [OPEN], [OPEN, SETTLED]];
    let rendered: (typeof OPEN)[] = [OPEN];
    let reads = 0;

    await pollSettledTranscript({
      fetchTranscript: async () => responses[reads++] ?? null,
      apply: (merge) => void (rendered = merge(rendered)),
      wait: async () => {},
    });

    expect(reads).toBe(3);
    expect(hasOpenInvestigation(rendered)).toBe(false);
  });

  it("gives up rather than polling forever, leaving the sweep as the backstop", async () => {
    let reads = 0;
    await pollSettledTranscript({
      fetchTranscript: async () => {
        reads++;
        return [OPEN];
      },
      apply: () => {},
      wait: async () => {},
      delays: [0, 0],
    });

    expect(reads).toBe(2);
  });

  it("keeps re-reading a stream that died mid-tool with no card open", async () => {
    // No investigation anywhere: only the dangling `get_report` says the turn is unfinished.
    const DANGLING = {
      id: "msg_step",
      role: "assistant",
      parts: [{ type: "tool-get_report", toolCallId: "call_1", state: "input-available" }],
    };
    const FINISHED = {
      id: "msg_step",
      role: "assistant",
      parts: [
        { type: "tool-get_report", toolCallId: "call_1", state: "output-available", output: {} },
      ],
    };

    const responses = [[DANGLING], [DANGLING], [FINISHED]];
    let rendered: (typeof DANGLING)[] = [DANGLING];
    let reads = 0;

    await pollSettledTranscript({
      fetchTranscript: async () => responses[reads++] ?? null,
      apply: (merge) => void (rendered = merge(rendered)),
      wait: async () => {},
    });

    expect(reads).toBe(3);
    expect(rendered).toEqual([FINISHED]);
    expect(transcriptLooksUnfinished(rendered)).toBe(false);
  });

  it("stops on a failed re-read instead of hammering the endpoint", async () => {
    let reads = 0;
    await pollSettledTranscript<typeof OPEN>({
      fetchTranscript: async () => {
        reads++;
        return null;
      },
      apply: () => {},
      wait: async () => {},
    });

    expect(reads).toBe(1);
  });
});
