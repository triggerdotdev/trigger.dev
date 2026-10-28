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

describe("the timeline is the answer for a run still executing, not workings", () => {
  const TIMELINE = {
    startedAt: "2025-01-01T00:00:00.000Z",
    elapsedMs: 190_000,
    asOf: "2025-01-01T00:03:10.000Z",
    phases: [
      { label: "Queued", startOffsetMs: 0, durationMs: 4_000, status: "done" as const },
      { label: "Dequeued", startOffsetMs: 4_100, status: "done" as const },
      { label: "run()", startOffsetMs: 64_000, status: "ongoing" as const },
      { label: "Retry limit hit", startOffsetMs: 90_000, status: "error" as const },
    ],
  };

  function withTimeline() {
    const base = block({});
    return {
      ...base,
      investigation: { ...base.investigation, timeline: TIMELINE },
    } as InvestigationBlock;
  }

  // It used to sit inside "How I worked this out", so a collapsed card hid it.
  it("shows without expanding the card", () => {
    const html = markup({ block: withTimeline() });
    expect(html).toContain("Timeline");
    expect(html).toContain("Queued");
    expect(html).toContain("run()");
  });

  it("shows an absolute timestamp per phase, not an offset", () => {
    const html = markup({ block: withTimeline() });
    // First row carries the date, later rows are time-only (same UTC day).
    expect(html).toContain("1 Jan 00:00:00.000");
    expect(html).toContain("00:00:04.100");
    expect(html).toContain("00:01:04.000");
    expect(html).toContain("00:01:30.000");
    expect(html).not.toMatch(/\+\d/);
  });

  it("keeps phases renderable when startedAt is malformed", () => {
    const base = block({});
    const malformedStart = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: { ...TIMELINE, startedAt: "not-a-date" },
      },
    } as InvestigationBlock;
    expect(() => markup({ block: malformedStart })).not.toThrow();
    const html = markup({ block: malformedStart });
    expect(html).toContain("Timeline");
    expect(html).toContain("Queued");
  });

  it("says so when the trace was truncated, so the phases don't read as complete", () => {
    const base = block({});
    const truncated = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: { ...TIMELINE, truncated: true },
      },
    } as InvestigationBlock;
    expect(markup({ block: truncated })).toContain("trace truncated");
    expect(markup({ block: withTimeline() })).not.toContain("trace truncated");
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
