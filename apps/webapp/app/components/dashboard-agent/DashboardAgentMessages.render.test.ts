import type { UIMessage } from "@ai-sdk/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentTurns, splitActionsBlocks } from "./DashboardAgentMessages";

/**
 * The model emits the actions block wherever it likes — the renderer pins the buttons to
 * the bottom of the turn. Static markup, so this proves the rendered order and nothing
 * about interaction.
 */

const actionsBlock = (label: string) => ({
  type: "actions",
  id: label,
  revision: 0,
  version: 1,
  actions: [{ label, intent: { kind: "ask", prompt: `${label}?` } }],
});

const card = {
  type: "investigation",
  id: "inv_1",
  revision: 0,
  version: 1,
  investigation: {
    outcome: "concluded",
    severity: "crit",
    confidence: "high",
    title: "A card that is not an actions row",
    headline: "Every attempt dies on a null order id.",
    remediation: "Guard the receipt builder against a missing order.",
    hypotheses: [],
    evidence: [],
  },
};

function text(value: string) {
  return { type: "text", text: value };
}

function view(...blocks: unknown[]) {
  return { type: "tool-render_view", state: "output-available", output: { blocks } };
}

function markup(parts: unknown[]) {
  const message = { id: "m1", role: "assistant", parts } as unknown as UIMessage;
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(DashboardAgentTurns, {
          messages: [message],
          activity: null,
          onIntent: () => {},
        })
      )
    )
  );
}

/** Every needle must be present: a missing one is -1, and -1 comparisons pass vacuously. */
function order(html: string, ...needles: string[]) {
  return needles.map((needle) => {
    const at = html.indexOf(needle);
    expect(at, `missing "${needle}"`).toBeGreaterThan(-1);
    return at;
  });
}

describe("action rows render at the end of the turn", () => {
  it("moves an actions block below the closing text it was emitted above", () => {
    const html = markup([
      text("Here is what I found."),
      view(actionsBlock("Watch it")),
      text("Want me to watch it?"),
    ]);

    const [found, offer, button] = order(
      html,
      "Here is what I found.",
      "Want me to watch it?",
      "Watch it"
    );
    expect(found).toBeGreaterThan(-1);
    expect(offer).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(offer);
  });

  it("keeps two actions blocks in their relative order, both after the card", () => {
    const html = markup([view(actionsBlock("First")), view(card), view(actionsBlock("Second"))]);

    const [summary, first, second] = order(
      html,
      "A card that is not an actions row",
      "First",
      "Second"
    );
    expect(first).toBeGreaterThan(summary);
    expect(second).toBeGreaterThan(first);
  });

  it("leaves a turn without actions exactly as emitted", () => {
    const html = markup([text("Only text."), view(card), text("Then more text.")]);

    const [only, summary, more] = order(
      html,
      "Only text.",
      "A card that is not an actions row",
      "Then more text."
    );
    expect(summary).toBeGreaterThan(only);
    expect(more).toBeGreaterThan(summary);
  });

  it("pulls the actions out of a block list that also carries a card", () => {
    const html = markup([view(actionsBlock("Watch it"), card), text("Want me to watch it?")]);

    const [summary, offer, button] = order(
      html,
      "A card that is not an actions row",
      "Want me to watch it?",
      "Watch it"
    );
    expect(offer).toBeGreaterThan(summary);
    expect(button).toBeGreaterThan(offer);
  });
});

describe("splitActionsBlocks", () => {
  it("separates actions from everything else, each keeping its order", () => {
    const first = actionsBlock("First");
    const second = actionsBlock("Second");
    expect(splitActionsBlocks([first, card, second])).toEqual({
      content: [card],
      actions: [first, second],
    });
  });

  it("returns no actions when the list has none", () => {
    expect(splitActionsBlocks([card])).toEqual({ content: [card], actions: [] });
  });
});
