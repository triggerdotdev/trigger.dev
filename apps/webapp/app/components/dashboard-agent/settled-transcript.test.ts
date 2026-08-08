import { VIEW_BLOCK_VERSION } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { liveProgress } from "./progress-line";
import {
  hasOpenInvestigation,
  mergeSettledMessages,
  pollSettledTranscript,
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
