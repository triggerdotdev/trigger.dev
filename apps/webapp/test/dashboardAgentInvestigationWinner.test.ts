import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import { winningInvestigationOccurrences } from "~/components/dashboard-agent/DashboardAgentMessages";

/**
 * The panel half of the pin invariant: the compactor pins the revision the panel
 * renders, so the transcripts in `compaction.test.ts` are resolved here too. The
 * message id carries the revision, so the winner names it.
 */
function investigationMessage(args: {
  id: string;
  title: string;
  outcome: string;
  revision?: number;
}): UIMessage {
  return {
    id: `msg-${args.id}-${args.revision ?? 0}`,
    role: "assistant",
    parts: [
      {
        type: "tool-render_view",
        toolCallId: `call-${args.id}-${args.revision ?? 0}`,
        state: "output-available",
        output: {
          blocks: [
            {
              type: "investigation",
              id: args.id,
              revision: args.revision ?? 0,
              version: 1,
              investigation: {
                outcome: args.outcome,
                severity: "warn",
                confidence: "medium",
                title: args.title,
                headline: `${args.title} — what we have so far.`,
                hypotheses: [],
                evidence: [],
              },
            },
          ],
        },
      } as never,
    ],
  };
}

describe("the winning revision of an investigation card", () => {
  it("is the highest revision, not the last render", () => {
    const winners = winningInvestigationOccurrences([
      investigationMessage({ id: "inv_1", title: "first pass", outcome: "in_progress" }),
      investigationMessage({ id: "inv_1", title: "first pass", outcome: "concluded", revision: 3 }),
      investigationMessage({
        id: "inv_1",
        title: "first pass",
        outcome: "in_progress",
        revision: 1,
      }),
    ]);

    expect(winners.get("inv_1")).toBe("msg-inv_1-3:0");
  });

  it("resolves a host-written card the same way", () => {
    const hostCard: UIMessage = {
      id: "host-inv_2-2",
      role: "assistant",
      parts: [
        {
          type: "data-view",
          data: {
            blocks: [{ type: "investigation", id: "inv_2", revision: 2, version: 1 }],
          },
        } as never,
      ],
    };

    expect(winningInvestigationOccurrences([hostCard]).get("inv_2")).toBe("host-inv_2-2:0");
  });
});
