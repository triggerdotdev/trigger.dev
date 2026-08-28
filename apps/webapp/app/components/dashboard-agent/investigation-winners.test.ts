import { readFileSync } from "node:fs";
import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import {
  blocksFor,
  stripStepParts,
  winningInvestigationOccurrences,
} from "./DashboardAgentMessages";
import { reuseWinners, sameOccurrences } from "./investigation-winners";

const source = readFileSync(new URL("./DashboardAgentMessages.tsx", import.meta.url), "utf8");

function recompute(entries: Array<[string, string]>): Map<string, string> {
  return new Map(entries.map(([id, occurrence]) => [id, occurrence]));
}

describe("investigation winners identity", () => {
  it("reuses the previous map when the winners are unchanged", () => {
    const first = recompute([["inv_1", "m1:0"]]);
    const second = recompute([["inv_1", "m1:0"]]);
    expect(second).not.toBe(first);

    expect(reuseWinners(first, second)).toBe(first);
  });

  it("takes the new map when a winner moves to another occurrence", () => {
    const first = recompute([["inv_1", "m1:0"]]);
    const moved = recompute([["inv_1", "m2:0"]]);

    expect(reuseWinners(first, moved)).toBe(moved);
  });

  it("takes the new map when an investigation appears", () => {
    const first = recompute([["inv_1", "m1:0"]]);
    const grown = recompute([
      ["inv_1", "m1:0"],
      ["inv_2", "m2:0"],
    ]);

    expect(reuseWinners(first, grown)).toBe(grown);
    expect(sameOccurrences(first, grown)).toBe(false);
  });

  it("has no previous map on the first render", () => {
    const only = recompute([["inv_1", "m1:0"]]);
    expect(reuseWinners(undefined, only)).toBe(only);
  });

  it("computes the winners inside a memo and reuses the reference", () => {
    expect(source).toMatch(/useMemo\(\(\) => winningInvestigationOccurrences\(messages\)/);
    expect(source).toContain("reuseWinners(previous.current, next)");
    expect(source).toContain("useInvestigationWinners(stripped)");
    expect(source).not.toMatch(/=\s*winningInvestigationOccurrences\(stripped\)/);
  });
});

/**
 * The turns are memoized on the message object, so a stripped message rebuilt on every
 * render defeats the memo for every tool-calling turn at once.
 */
describe("stripped message identity", () => {
  function withStepStart(): UIMessage {
    return {
      id: "m1",
      role: "assistant",
      parts: [{ type: "step-start" }, { type: "text", text: "hello" }],
    } as unknown as UIMessage;
  }

  it("returns the very same reference when there is nothing to strip", () => {
    const plain = { id: "m1", role: "assistant", parts: [{ type: "text", text: "hi" }] };
    const message = plain as unknown as UIMessage;

    expect(stripStepParts(message)).toBe(message);
  });

  it("returns the same stripped reference on every later call", () => {
    const message = withStepStart();
    const first = stripStepParts(message);

    expect(first).not.toBe(message);
    expect(first.parts).toHaveLength(1);
    for (let token = 0; token < 20; token++) {
      expect(stripStepParts(message)).toBe(first);
    }
  });

  it("strips a different message to its own reference", () => {
    const a = withStepStart();
    const b = withStepStart();

    expect(stripStepParts(a)).not.toBe(stripStepParts(b));
    expect(stripStepParts(a)).toBe(stripStepParts(a));
  });
});

/**
 * The winner pass runs once per streamed token over the whole transcript, so it must
 * not touch report payloads. `output` is a counting getter because a report parse is
 * otherwise silent: it returns `null` on a bad payload rather than throwing.
 */
function countingReportPart(vm: unknown) {
  let reads = 0;
  const part = {
    type: "tool-get_report",
    state: "output-available",
    toolCallId: "toolcall_1",
    get output() {
      reads++;
      return { vm };
    },
  };
  return { part: part as unknown as UIMessage["parts"][number], reads: () => reads };
}

const VALID_VM = {
  title: "health",
  scope: "prod",
  period: "last 1h",
  generatedAt: "2026-07-27T10:15:00.000Z",
  windowMinutes: 60,
  summary: { severity: "ok", statements: [] },
};

describe("the winner pass does not parse report blocks", () => {
  it("leaves a report part's payload untouched", () => {
    const valid = countingReportPart(VALID_VM);
    // Would fail `reportBlockSchema`: no `generatedAt`, no `windowMinutes`.
    const invalid = countingReportPart({ title: "health" });

    const messages = [
      { id: "m1", role: "assistant", parts: [valid.part, invalid.part] },
    ] as unknown as UIMessage[];

    let winners: Map<string, string> | undefined;
    expect(() => (winners = winningInvestigationOccurrences(messages))).not.toThrow();

    expect(winners!.size).toBe(0);
    expect(valid.reads()).toBe(0);
    expect(invalid.reads()).toBe(0);
  });

  it("still parses the same part when the turn renders it", () => {
    const valid = countingReportPart(VALID_VM);
    const blocks = blocksFor(valid.part);

    expect(valid.reads()).toBeGreaterThan(0);
    expect(blocks).toHaveLength(1);
    expect((blocks![0] as { type: string }).type).toBe("report");
  });

  it("still finds investigation winners emitted by the view tools", () => {
    const messages = [
      {
        id: "m1",
        role: "assistant",
        parts: [
          countingReportPart(VALID_VM).part,
          {
            type: "tool-render_view",
            output: { blocks: [{ type: "investigation", id: "inv_1", revision: 0 }] },
          },
        ],
      },
      {
        id: "m2",
        role: "assistant",
        parts: [
          {
            type: "data-view",
            data: { blocks: [{ type: "investigation", id: "inv_1", revision: 1 }] },
          },
        ],
      },
    ] as unknown as UIMessage[];

    expect(winningInvestigationOccurrences(messages)).toEqual(new Map([["inv_1", "m2:0"]]));
  });
});
