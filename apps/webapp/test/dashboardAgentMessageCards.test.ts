import type { UIMessage } from "ai";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DashboardAgentTurns,
  winningInvestigationOccurrences,
} from "~/components/dashboard-agent/DashboardAgentMessages";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";

/**
 * The two halves of card rendering that have to agree: which occurrence of an investigation
 * wins, and which part index the renderer is standing on when it asks. Static markup, so it
 * proves what reaches the page, not what the browser paints: no click is exercised.
 */

function investigationBlock(id: string, revision: number, title = id) {
  return {
    type: "investigation",
    id,
    revision,
    version: 1,
    investigation: {
      outcome: "concluded",
      severity: "warn",
      confidence: "medium",
      title,
      headline: `${title} — what we have so far.`,
      hypotheses: [],
      evidence: [],
    },
  };
}

const stepStart = { type: "step-start" } as never;

function toolCard(id: string, revision: number, title?: string) {
  return {
    type: "tool-render_view",
    toolCallId: `call-${id}-${revision}`,
    state: "output-available",
    output: { blocks: [investigationBlock(id, revision, title)] },
  } as never;
}

function hostCard(id: string, revision: number, title?: string) {
  return {
    type: "data-view",
    data: { blocks: [investigationBlock(id, revision, title)] },
  } as never;
}

function message(id: string, parts: UIMessage["parts"]): UIMessage {
  return { id, role: "assistant", parts };
}

/** The transcript as the panel renders it. Providers are what the Button primitive needs. */
function markup(messages: UIMessage[]) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(DashboardAgentTurns, { messages, activity: null })
      )
    )
  );
}

describe("the winner's part index and the renderer's part index are the same index", () => {
  it("counts the parts the renderer walks, not the ones it drops", () => {
    // The step separator is stripped before rendering, so the card is part 0 on screen.
    const withSeparator = message("msg-1", [stepStart, toolCard("inv_1", 0)]);
    expect(winningInvestigationOccurrences([withSeparator]).get("inv_1")).toBe("msg-1:0");
  });

  it("keeps the card a reply with step separators would otherwise lose", () => {
    const html = markup([message("msg-1", [stepStart, toolCard("inv_1", 0, "the card")])]);

    expect(html).toContain("the card");
  });
});

describe("a host-written card and a tool-rendered card compete on equal terms", () => {
  it("renders a host-written card, so winning one cannot mean rendering nothing", () => {
    const html = markup([message("msg-host", [hostCard("inv_2", 1, "the host card")])]);

    expect(html).toContain("the host card");
  });

  it("drops the superseded revision and keeps the winner, whichever carrier it arrived in", () => {
    const older = message("msg-tool", [toolCard("inv_3", 1, "the older card")]);
    const newer = message("msg-host", [hostCard("inv_3", 2, "the newer card")]);

    expect(winningInvestigationOccurrences([older, newer]).get("inv_3")).toBe("msg-host:0");

    const html = markup([older, newer]);
    expect(html).toContain("the newer card");
    expect(html).not.toContain("the older card");
  });
});
