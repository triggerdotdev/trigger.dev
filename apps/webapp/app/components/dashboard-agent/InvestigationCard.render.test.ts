import type { InvestigationBlock } from "@internal/dashboard-agent-contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OperatingSystemContextProvider } from "~/components/primitives/OperatingSystemProvider";
import { ShortcutsProvider } from "~/components/primitives/ShortcutsProvider";
import {
  dedupeDurationSuffix,
  InvestigationCard,
  splitTrailingParenthetical,
} from "./InvestigationCard";

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

  it("puts the duration under the title as the line to the next phase, in compact units", () => {
    const html = markup({ block: withTimeline() });
    // Queued ran for 4s before Dequeued fired, an instant with no duration of its own.
    expect(html).toContain("4 s");
    expect(html).not.toContain("4 seconds");
    expect(html).toContain("ongoing");
  });

  it("capitalises the displayed title but keeps the original lowercase in the hover title", () => {
    const base = block({});
    const lowercasePhase = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: {
          ...TIMELINE,
          phases: [{ label: "run", startOffsetMs: 0, status: "done" as const }],
        },
      },
    } as InvestigationBlock;
    const html = markup({ block: lowercasePhase });
    expect(html).toContain('title="run"');
    const titleSpan = html.match(/<span title="run"[^>]*>([^<]*)<\/span>/);
    expect(titleSpan?.[1]).toBe("Run");
  });

  it("leaves a label alone when it already starts with a non-letter", () => {
    const base = block({});
    const symbolPhase = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: {
          ...TIMELINE,
          phases: [{ label: "(anonymous)", startOffsetMs: 0, status: "done" as const }],
        },
      },
    } as InvestigationBlock;
    expect(markup({ block: symbolPhase })).toContain("(anonymous)");
  });

  it("uses the same compact units in the elapsed footer as the segment labels", () => {
    const html = markup({ block: withTimeline() });
    // TIMELINE.elapsedMs is 190_000ms.
    expect(html).toContain("3 min 10 s elapsed");
    expect(html).not.toContain("3m 10s");
  });

  it("abbreviates minutes as 'min', not 'm', so it isn't read as metres", () => {
    const base = block({});
    const longPhase = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: {
          ...TIMELINE,
          phases: [
            { label: "Queued", startOffsetMs: 0, durationMs: 371, status: "done" as const },
            {
              label: "run()",
              startOffsetMs: 371,
              durationMs: 3_780_000,
              status: "done" as const,
            },
          ],
        },
      },
    } as InvestigationBlock;
    const html = markup({ block: longPhase });
    expect(html).toContain("371 ms");
    expect(html).toContain("1 h 3 min");
  });

  it("marks each phase with its derived timeline state, not the raw status", () => {
    const html = markup({ block: withTimeline() });
    expect(html).toContain('data-state="complete"');
    expect(html).toContain('data-state="inprogress"');
    expect(html).toContain('data-state="error"');
    expect(html).not.toContain('data-state="done"');
    expect(html).not.toContain('data-state="ongoing"');
  });

  it("keeps the connecting line continuous, one connector between each pair of events", () => {
    const html = markup({ block: withTimeline() });
    const connectorCount = (html.match(/data-connector/g) ?? []).length;
    expect(connectorCount).toBe(TIMELINE.phases.length - 1);
  });

  it("keeps every connector thin, including the in-progress one before an ongoing phase", () => {
    const html = markup({ block: withTimeline() });
    const connectorRows = html.split("data-connector").slice(1);
    expect(connectorRows.length).toBe(TIMELINE.phases.length - 1);
    for (const row of connectorRows) {
      expect(row).toContain("w-px");
      expect(row).not.toContain("w-1.75");
    }
    // The connector before "run()" (ongoing) still animates, just thinly.
    expect(html).toContain("animate-tile-scroll");
  });

  it("shrinks only the trailing connector, under the final (ongoing) phase", () => {
    const base = block({});
    const endsOngoing = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: {
          ...TIMELINE,
          phases: [
            { label: "Queued", startOffsetMs: 0, durationMs: 4_000, status: "done" as const },
            { label: "Dequeued", startOffsetMs: 4_100, durationMs: 200, status: "done" as const },
            { label: "run()", startOffsetMs: 4_300, status: "ongoing" as const },
          ],
        },
      },
    } as InvestigationBlock;
    const html = markup({ block: endsOngoing });
    const connectorRows = html.split("data-connector").slice(1);
    expect(connectorRows.length).toBe(3);
    // Queued→Dequeued and Dequeued→run() are intermediate; the trailing row is under run().
    expect(connectorRows[0]).toContain("min-h-9");
    expect(connectorRows[1]).toContain("min-h-9");
    expect(connectorRows[2]).toContain("min-h-5");
    expect(connectorRows[2]).not.toContain("min-h-9");
  });

  it("puts no spacing class on the event row itself — the gap lives in the connector", () => {
    const html = markup({ block: withTimeline() });
    const eventRows = [...html.matchAll(/<div data-state="[^"]*"[^>]*>/g)];
    expect(eventRows.length).toBe(TIMELINE.phases.length);
    for (const [tag] of eventRows) {
      expect(tag).not.toMatch(/\bp[btlrxy]?-\d/);
    }
  });

  it("strips a trailing duration then a trailing parenthetical, keeping a non-duration remainder", () => {
    const deduped = dedupeDurationSuffix("chat turn 1 — 471 s (4 LLM steps)");
    expect(deduped).toBe("chat turn 1 (4 LLM steps)");
    expect(splitTrailingParenthetical(deduped)).toEqual({
      display: "chat turn 1",
      extra: "4 LLM steps",
    });
  });

  it("renders the title without parentheses, keeping the full label for hover", () => {
    const base = block({});
    const withDedupedLabel = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: {
          ...TIMELINE,
          phases: [
            {
              label: "chat turn 1 — 471 s (4 LLM steps)",
              startOffsetMs: 0,
              durationMs: 471_000,
              status: "done" as const,
            },
          ],
        },
      },
    } as InvestigationBlock;
    const html = markup({ block: withDedupedLabel });
    expect(html).toContain('title="chat turn 1 — 471 s (4 LLM steps)"');
    const titleSpan = html.match(/<span title="chat turn 1[^"]*"[^>]*>([^<]*)<\/span>/);
    // Display is capitalised; the hover title keeps the original lowercase label.
    expect(titleSpan?.[1]).toBe("Chat turn 1");
    expect(titleSpan?.[1]).not.toContain("(");
  });

  it("shows the info icon whenever a phase has extra context, parenthetical or detail", () => {
    const base = block({});
    const withDetail = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: {
          ...TIMELINE,
          phases: [
            {
              label: "Dequeued",
              startOffsetMs: 0,
              status: "done" as const,
              detail: "queued behind 3 other runs",
            },
          ],
        },
      },
    } as InvestigationBlock;
    expect(markup({ block: withDetail })).toContain("text-text-dimmed flex-0");
  });

  it("shows no info icon when a phase has neither a parenthetical nor a detail", () => {
    const base = block({});
    const plain = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: {
          ...TIMELINE,
          phases: [{ label: "Queued", startOffsetMs: 0, status: "done" as const }],
        },
      },
    } as InvestigationBlock;
    expect(markup({ block: plain })).not.toContain("text-text-dimmed flex-0");
  });

  it("leaves the section out when there are no phases", () => {
    const base = block({});
    const empty = {
      ...base,
      investigation: {
        ...base.investigation,
        timeline: { ...TIMELINE, phases: [] },
      },
    } as InvestigationBlock;
    expect(markup({ block: empty })).not.toContain("Timeline");
  });

  it("renders the phases without timestamps instead of throwing on a malformed startedAt", () => {
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
    // The per-phase timestamp span (not the footer's `asOf`, which is still valid) is dropped.
    expect(html).not.toContain("tracking-[-0.05rem]");
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
