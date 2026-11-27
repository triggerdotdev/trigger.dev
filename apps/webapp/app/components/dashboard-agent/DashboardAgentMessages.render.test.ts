import type { UIMessage } from "@ai-sdk/react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { DashboardAgentTurns, seriesCopyText, splitActionsBlocks } from "./DashboardAgentMessages";

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

function markup(
  parts: unknown[],
  { role = "assistant", activity = null }: { role?: string; activity?: "working" | null } = {}
) {
  return markupOf([{ role, parts }], activity);
}

function markupOf(turns: { role: string; parts: unknown[] }[], activity: "working" | null = null) {
  const messages = turns.map((turn, i) => ({ id: `m${i}`, ...turn }) as unknown as UIMessage);
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(
        ShortcutsProvider,
        null,
        createElement(DashboardAgentTurns, {
          messages,
          activity,
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

describe("copy button", () => {
  const copyLabel = 'aria-label="Copy"';
  const buttons = (html: string) => html.split(copyLabel).length - 1;
  const turn = (role: string, ...parts: unknown[]) => ({ role, parts });
  const notice = () => ({ ...turn("assistant", text("Watch fired.")), id: "wake:1" });
  const toolOnly = [
    { type: "tool-render_view", state: "output-available", output: { blocks: [] } },
  ];

  it.each([
    ["user", "user", "hello", null, 0],
    ["settled assistant", "assistant", "an answer", null, 1],
    ["streaming assistant", "assistant", "an answer", "working" as const, 0],
    ["assistant with only whitespace text", "assistant", "  \n", null, 0],
  ])("%s turn", (_name, role, body, activity, count) => {
    expect(buttons(markup([text(body)], { role, activity }))).toBe(count);
  });

  it("is absent from a tool-only assistant turn", () => {
    expect(buttons(markup(toolOnly))).toBe(0);
  });

  it.each([
    ["three assistant messages", ["assistant", "assistant", "assistant"], null, 1],
    ["user, assistant, assistant, user", ["user", "assistant", "assistant", "user"], null, 1],
    [
      "a streaming series, earlier series kept",
      ["assistant", "user", "assistant"],
      "working" as const,
      1,
    ],
  ])("%s", (_name, roles, activity, count) => {
    const turns = roles.map((role, i) => turn(role, text(`msg ${i}`)));
    expect(buttons(markupOf(turns, activity))).toBe(count);
  });

  it.each([
    ["a user message followed by a notification", [turn("user", text("q")), notice()], 1],
    ["a reply in progress followed by a notification", [turn("assistant", text("a")), notice()], 0],
  ])("while working, %s", (_name, turns, count) => {
    expect(buttons(markupOf(turns, "working"))).toBe(count);
  });

  it("puts the button after the last message of the series", () => {
    const html = markupOf([
      turn("assistant", text("FIRST_MARK")),
      turn("assistant", text("LAST_MARK")),
    ]);
    const [last, button] = [html.indexOf("LAST_MARK"), html.indexOf(copyLabel)];
    expect(last).toBeGreaterThan(-1);
    expect(button).toBeGreaterThan(last);
  });

  it("ignores an assistant message that renders nothing", () => {
    const html = markupOf([
      turn("assistant", text("answer")),
      turn("assistant", { type: "step-start" }),
    ]);
    expect(buttons(html)).toBe(1);
  });

  it("copies the prose of every message in the series, in order", () => {
    const message = (id: string, role: string, ...parts: unknown[]) =>
      ({ id, role, parts }) as unknown as UIMessage;
    const series = [
      message(
        "a",
        "assistant",
        text("first"),
        { type: "reasoning", text: "NOTE_MARK" },
        { type: "reasoning", text: "" }
      ),
      message("b", "assistant", {
        type: "tool-lookup",
        state: "output-available",
        output: "TOOL_OUTPUT_MARK",
      }),
      message(
        "c",
        "assistant",
        { type: "source-url", url: "https://example.com/SOURCE_MARK" },
        { type: "data-note", data: "DATA_MARK" },
        text(""),
        text("**second** ![x](https://evil.test/a.png)"),
        text("third")
      ),
    ];
    expect(seriesCopyText(series)).toBe("first\n\nNOTE_MARK\n\n**second** x\n\nthird");
  });
});
