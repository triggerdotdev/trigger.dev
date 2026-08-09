import type { UIMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  DashboardAgentMessageBubble,
  winningInvestigationOccurrences,
} from "~/components/dashboard-agent/DashboardAgentMessages";

/**
 * The two halves of card rendering that have to agree: which occurrence of an investigation
 * wins, and which part index the renderer is standing on when it asks. Structural — these call
 * the component as a function and read the returned element tree, so they prove what is handed
 * to `ViewBlocks`, not what the browser paints.
 */

function investigationBlock(id: string, revision: number) {
  return {
    type: "investigation",
    id,
    revision,
    version: 1,
    investigation: {
      outcome: "concluded",
      severity: "warn",
      confidence: "medium",
      title: id,
      headline: `${id} — what we have so far.`,
      hypotheses: [],
      evidence: [],
    },
  };
}

const stepStart = { type: "step-start" } as never;

function toolCard(id: string, revision: number) {
  return {
    type: "tool-render_view",
    toolCallId: `call-${id}-${revision}`,
    state: "output-available",
    output: { blocks: [investigationBlock(id, revision)] },
  } as never;
}

function hostCard(id: string, revision: number) {
  return { type: "data-view", data: { blocks: [investigationBlock(id, revision)] } } as never;
}

function message(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts };
}

/** Every `ViewBlocks` element in the rendered tree, with the blocks it was handed. */
function renderedBlocks(node: unknown): unknown[][] {
  const found: unknown[][] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk);
    const element = value as { props?: { blocks?: unknown[]; children?: unknown } } | null;
    if (!element || typeof element !== "object") return;
    if (Array.isArray(element.props?.blocks)) found.push(element.props.blocks);
    if (element.props?.children) walk(element.props.children);
  };
  walk(node);
  return found;
}

function renderBubble(msg: UIMessage, winners?: Map<string, string>) {
  return renderedBlocks(
    DashboardAgentMessageBubble({ message: msg, investigationWinners: winners })
  );
}

describe("the winner's part index and the renderer's part index are the same index", () => {
  it("counts the parts the renderer walks, not the ones it drops", () => {
    // The step separator is stripped before rendering, so the card is part 0 on screen.
    const withSeparator = message("msg-1", [stepStart, toolCard("inv_1", 0)]);
    expect(winningInvestigationOccurrences([withSeparator]).get("inv_1")).toBe("msg-1:0");
  });

  it("keeps the card a reply with step separators would otherwise lose", () => {
    const withSeparator = message("msg-1", [stepStart, toolCard("inv_1", 0)]);
    const winners = winningInvestigationOccurrences([withSeparator]);

    // What DashboardAgentMessages renders: the stripped message, against those winners.
    const stripped = message("msg-1", [toolCard("inv_1", 0)]);
    const blocks = renderBubble(stripped, winners);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toHaveLength(1);
  });
});

describe("a host-written card and a tool-rendered card compete on equal terms", () => {
  it("renders a host-written card, so winning one cannot mean rendering nothing", () => {
    const blocks = renderBubble(message("msg-host", [hostCard("inv_2", 1)]));
    expect(blocks).toHaveLength(1);
    expect((blocks[0][0] as { id: string }).id).toBe("inv_2");
  });

  it("drops the superseded revision and keeps the winner, whichever carrier it arrived in", () => {
    const older = message("msg-tool", [toolCard("inv_3", 1)]);
    const newer = message("msg-host", [hostCard("inv_3", 2)]);
    const winners = winningInvestigationOccurrences([older, newer]);

    expect(winners.get("inv_3")).toBe("msg-host:0");
    expect(renderBubble(older, winners)).toHaveLength(0);
    expect(renderBubble(newer, winners)).toHaveLength(1);
  });
});
