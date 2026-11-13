import type { ActionsBlockAction } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { answerContinuesAfter, renderableActions, withoutWatchActions } from "./view-actions";

const watchAction: ActionsBlockAction = {
  label: "Set up a watch",
  intent: {
    kind: "watch",
    spec: {
      kind: "error_recurrence",
      fingerprint: "a1b2c3",
      checkEveryMinutes: 15,
      maxHours: 6,
      note: "the TypeError in send-order-receipt",
    },
  },
};

const askAction: ActionsBlockAction = {
  label: "Investigate it",
  intent: { kind: "ask", prompt: "Investigate the send-order-receipt failures." },
};

describe("renderableActions", () => {
  it("drops a navigate action whose target isn't a trigger:// URI", () => {
    const actions: ActionsBlockAction[] = [
      askAction,
      { label: "Runs", intent: { kind: "navigate", target: "/runs?status=FAILED" } },
    ];
    expect(renderableActions(actions)).toEqual([askAction]);
  });

  it("keeps a navigate action with a canonical target", () => {
    const navigate: ActionsBlockAction = {
      label: "See its failed runs",
      intent: { kind: "navigate", target: "trigger://proj_abc/env_abc/runs" },
    };
    expect(renderableActions([navigate])).toEqual([navigate]);
  });

  it("keeps a watch action, spec intact — that spec is what pre-fills the card", () => {
    expect(renderableActions([watchAction, askAction])).toEqual([watchAction, askAction]);
  });

  it("can filter every action out, leaving nothing to render", () => {
    expect(
      renderableActions([{ label: "Nowhere", intent: { kind: "navigate", target: "nope" } }])
    ).toEqual([]);
  });
});

describe("keep digging, only while there is digging left", () => {
  const card = { type: "data-view" };
  const text = (t: string) => ({ type: "text", text: t });

  it("sees the answer the turn went on to give", () => {
    expect(answerContinuesAfter([card, text("so here is why")] as never, 0)).toBe(true);
  });

  it("leaves a card the turn ended on", () => {
    expect(answerContinuesAfter([text("looking"), card] as never, 1)).toBe(false);
    // An empty trailing text part is not an answer.
    expect(answerContinuesAfter([card, text("  ")] as never, 0)).toBe(false);
  });

  it("counts a progress note after the card as the answer going on", () => {
    expect(answerContinuesAfter([card, { type: "reasoning", text: "so here is why" }], 0)).toBe(
      true
    );
    // Thinking with its text omitted is not an answer.
    expect(answerContinuesAfter([card, { type: "reasoning", text: "" }], 0)).toBe(false);
  });
});

describe("withoutWatchActions", () => {
  it("drops a stored watch offer, keeping everything else", () => {
    expect(
      withoutWatchActions([
        { label: "Set up a watch", intent: { kind: "watch", spec: {} } },
        { label: "View similar", intent: { kind: "navigate", target: "trigger://x" } },
      ] as never)
    ).toEqual([{ label: "View similar", intent: { kind: "navigate", target: "trigger://x" } }]);
  });
});
