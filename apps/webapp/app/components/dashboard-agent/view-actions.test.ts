import type { ActionsBlockAction } from "@internal/dashboard-agent-contracts";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  answerContinuesAfter,
  cardAlreadyOffersWatch,
  renderableActions,
  turnAlreadyOffersWatch,
  turnProposesWatch,
  withoutWatchActions,
} from "./view-actions";

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
});

describe("one watch button per answer", () => {
  const watchAction = { label: "Watch for a repeat", intent: { kind: "watch" as const, spec: {} } };
  const card = (actions: unknown[]) =>
    ({ type: "investigation", investigation: {}, capabilities: { actions } }) as never;

  it("sees the card's own watch offer", () => {
    expect(cardAlreadyOffersWatch([card([watchAction])])).toBe(true);
  });

  it("leaves an answer whose card offers no watch alone", () => {
    expect(
      cardAlreadyOffersWatch([
        card([{ label: "Keep digging", intent: { kind: "ask", prompt: "" } }]),
      ])
    ).toBe(false);
    expect(cardAlreadyOffersWatch([])).toBe(false);
  });

  // The bug this closes: one `render_view` call carries the investigation card and a second
  // carries the actions block, so each call asked only about its own blocks and said no.
  it("sees a watch offered by another of the same turn's render_view calls", () => {
    const investigationCall = [card([watchAction])];
    const actionsCall = [{ type: "actions", actions: [watchAction] }] as never[];

    expect(cardAlreadyOffersWatch(actionsCall)).toBe(false);
    // Either order: the card can be rendered before or after the block that repeats it.
    expect(turnAlreadyOffersWatch([investigationCall, actionsCall])).toBe(true);
    expect(turnAlreadyOffersWatch([actionsCall, investigationCall])).toBe(true);
  });

  // The report card grows its own "Watch…" button from the view model, so the block
  // carries no watch action to match on.
  const reportCard = (title: string, severity: string) =>
    ({ type: "report", vm: { title, summary: { severity, statements: [] } } }) as never;

  it("sees the health report card's recovery watch", () => {
    expect(cardAlreadyOffersWatch([reportCard("health", "crit")])).toBe(true);
    expect(cardAlreadyOffersWatch([reportCard("health", "warn")])).toBe(true);
    const actionsCall = [{ type: "actions", actions: [watchAction] }] as never[];
    expect(turnAlreadyOffersWatch([[reportCard("health", "crit")], actionsCall])).toBe(true);
  });

  it("leaves a report card with no watch button alone", () => {
    // Green: nothing to recover from. And only the health report has a recovery watch.
    expect(cardAlreadyOffersWatch([reportCard("health", "ok")])).toBe(false);
    expect(cardAlreadyOffersWatch([reportCard("cost", "crit")])).toBe(false);
  });

  it("says no when no call in the turn has a card offering one", () => {
    const plain = [card([{ label: "Keep digging", intent: { kind: "ask", prompt: "" } }])];
    expect(turnAlreadyOffersWatch([plain, []])).toBe(false);
    expect(turnAlreadyOffersWatch([])).toBe(false);
  });

  it("drops the model's duplicate offer, keeping everything else", () => {
    expect(
      withoutWatchActions([
        { label: "Set up a watch", intent: { kind: "watch", spec: {} } },
        { label: "View similar", intent: { kind: "navigate", target: "trigger://x" } },
      ] as never)
    ).toEqual([{ label: "View similar", intent: { kind: "navigate", target: "trigger://x" } }]);
  });
});

describe("a turn that proposed a watch through the tool", () => {
  const text = { type: "text", text: "here is what I found" };
  const scheduled = (output: unknown, state = "output-available") => ({
    type: "tool-schedule_watch",
    state,
    output,
  });
  const intent = { intent: watchAction.intent };

  it("sees the proposal that opened the card", () => {
    expect(turnProposesWatch([text, scheduled(intent)])).toBe(true);
  });

  it("leaves the button alone when the spec was rejected — no card opened", () => {
    expect(turnProposesWatch([text, scheduled({ error: "Couldn't build that watch: bad" })])).toBe(
      false
    );
  });

  it("waits for the output: a call still running proposes nothing", () => {
    expect(turnProposesWatch([scheduled(intent, "input-available")])).toBe(false);
    expect(turnProposesWatch([{ type: "tool-schedule_watch", output: intent }])).toBe(false);
    expect(turnProposesWatch([text])).toBe(false);
  });
});

describe("ActionsBlock", () => {
  const source = readFileSync(new URL("./ActionsBlock.tsx", import.meta.url), "utf8");

  it("hands the action's own intent to the host, and renders nothing without one", () => {
    expect(source).toContain("onIntent(action.intent");
    expect(source).toContain("if (!onIntent || renderable.length === 0) return null;");
  });

  it("filters through the shared filter rather than rendering every action", () => {
    expect(source).toContain("renderableActions(actions)");
  });

  it("is a pure component: no app hooks, no server module, no Remix", () => {
    expect(source).not.toMatch(/from\s+"~\/hooks\//);
    expect(source).not.toMatch(/from\s+"@remix-run\//);
    expect(source).not.toMatch(/\.server"/);
  });
});

/**
 * There is no rendering harness here, so this pins the wiring rather than the pixels: the
 * turn-wide answer is computed where every part is in scope and reaches every card, and
 * `ViewBlocks` can only add to it. What it does not prove is that the button disappears.
 */
describe("the one-watch-button flag is decided per turn, not per render_view call", () => {
  const turn = readFileSync(new URL("./DashboardAgentMessages.tsx", import.meta.url), "utf8");
  const catalog = readFileSync(new URL("./view-catalog.tsx", import.meta.url), "utf8");

  it("computes it over every part's blocks, above the per-part loop", () => {
    expect(turn).toContain("turnAlreadyOffersWatch(");
    // Above the loop: computed from the whole `parts` map, not from one part.
    expect(turn.indexOf("const watchOfferedInTurn")).toBeLessThan(
      turn.indexOf("for (let i = 0; i < parts.length; i++)")
    );
    expect(turn).toContain("watchOfferedInTurn={watchOfferedInTurn}");
  });

  it("counts the turn's own schedule_watch proposal as an offer", () => {
    expect(turn).toMatch(/turnProposesWatch\(parts as never\) \|\|/);
  });

  it("lets a card add its own offer but never drop the turn's", () => {
    expect(catalog).toMatch(/watchOfferedInTurn \|\|\s*cardAlreadyOffersWatch\(/);
  });
});
