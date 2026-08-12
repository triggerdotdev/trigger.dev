import type { InvestigationBlock } from "@internal/dashboard-agent-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import { InvestigationCard } from "./InvestigationCard";

/**
 * What the card actually puts on the page, rather than what its source says. Static markup,
 * so it proves the rendered output and nothing about interaction: a click is not exercised.
 */

const HYPOTHESIS = {
  id: "h1",
  statement: "The receipt builder is handed a null order id.",
  verdict: "validated" as const,
  evidence: [],
};

function block(overrides: {
  hypotheses?: InvestigationBlock["investigation"]["hypotheses"];
  actions?: NonNullable<InvestigationBlock["capabilities"]>["actions"];
}): InvestigationBlock {
  return {
    type: "investigation",
    id: "inv_1",
    revision: 0,
    version: 1,
    investigation: {
      outcome: "concluded",
      severity: "crit",
      confidence: "high",
      title: "send-order-receipt fails on every retry",
      headline: "Every attempt dies on a null order id.",
      remediation: "Guard the receipt builder against a missing order.",
      hypotheses: overrides.hypotheses ?? [],
      evidence: [],
    },
    ...(overrides.actions
      ? { capabilities: { version: 1, actions: overrides.actions } }
      : undefined),
  } as InvestigationBlock;
}

// The Button primitive reads both of these for its shortcut hints.
function markup(props: Parameters<typeof InvestigationCard>[0]) {
  return renderToStaticMarkup(
    createElement(
      OperatingSystemContextProvider,
      { platform: "mac" },
      createElement(ShortcutsProvider, null, createElement(InvestigationCard, props))
    )
  );
}

describe("the card's sections appear only when they have something in them", () => {
  it("leaves out an empty Hypotheses heading, the way Evidence already does", () => {
    const html = markup({ block: block({}), defaultExpanded: true });
    expect(html).not.toContain("Hypotheses");
    expect(html).not.toContain("Evidence");
  });

  it("shows the heading once there is a hypothesis under it", () => {
    const html = markup({ block: block({ hypotheses: [HYPOTHESIS] }), defaultExpanded: true });
    expect(html).toContain("Hypotheses");
    expect(html).toContain("The receipt builder is handed a null order id.");
  });
});

describe("action buttons need a host to hand the intent to", () => {
  const actions = [
    {
      kind: "ask_follow_up" as const,
      label: "Keep digging",
      intent: { kind: "ask" as const, prompt: "Keep digging into the receipt failures." },
    },
  ];

  it("renders no button when the host passes no onIntent, rather than a dead one", () => {
    const html = markup({ block: block({ actions }), defaultExpanded: true });
    expect(html).not.toContain("Keep digging");
  });

  it("renders the same action once a host can act on it", () => {
    const html = markup({ block: block({ actions }), defaultExpanded: true, onIntent: () => {} });
    expect(html).toContain("Keep digging");
  });
});
