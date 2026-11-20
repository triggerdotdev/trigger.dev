import { describe, expect, it } from "vitest";
import {
  panelLinksToRunPage,
  runLoadNote,
  runNotShown,
  spanNotLoaded,
  startingEndsAtMs,
  type RunFacts,
} from "~/components/sessions/v1/trace/sessionRunNote";
import { isRunReadSettled } from "~/components/sessions/v1/trace/sessionRunLoads";

const TRIGGERED_AT = "2026-10-29T10:00:00.000Z";
const triggeredMs = new Date(TRIGGERED_AT).getTime();
const facts = (overrides: Partial<RunFacts> = {}): RunFacts => ({
  number: 20,
  reason: "continuation",
  afterCrash: false,
  triggeredAt: TRIGGERED_AT,
  unavailable: undefined,
  ...overrides,
});
const note = (
  overrides: Partial<Parameters<typeof runNotShown>[0]> = {}
): ReturnType<typeof runNotShown> =>
  runNotShown({
    facts: facts(),
    inRunStore: true,
    loadNote: undefined,
    nowMs: triggeredMs,
    ...overrides,
  });

describe("the run panel's note, from facts", () => {
  // Catches: a run that loads fine getting a panel note.
  it("says nothing for a run in the run store that loads", () => {
    expect(note()).toBeUndefined();
  });

  // Catches: "hasn't started yet" over a run that has since reached the run store (review
  // rounds 1–3: a stored "starting" outlived the run starting).
  it("never says starting once the run is in the run store, whatever time it is", () => {
    expect(note({ inRunStore: true, nowMs: triggeredMs + 60_000 })).toBeUndefined();
  });

  // Catches: "starting" never expiring, so a stuck run kept a run page link that 404s.
  it("turns starting into never started 5 minutes after the run was triggered", () => {
    expect(note({ inRunStore: false, nowMs: triggeredMs + 60_000 })?.kind).toBe("starting");
    expect(note({ inRunStore: false, nowMs: startingEndsAtMs(facts()) })?.kind).toBe(
      "neverStarted"
    );
  });

  // Catches: a note before anything is known about the run.
  it("says nothing before the run's facts are known", () => {
    expect(note({ facts: undefined, inRunStore: false })).toBeUndefined();
  });

  // Catches: what the runs route said losing to a stale load note, or not showing at all.
  it("puts what the runs route said before what a read found", () => {
    const cutOff = runLoadNote({
      state: "cutOff",
      limit: "session",
      started: true,
      spanLimit: 150_000,
      loadId: 1,
    });
    expect(note({ facts: facts({ unavailable: "logsDeleted" }), loadNote: cutOff })?.kind).toBe(
      "logsDeleted"
    );
    expect(note({ facts: facts({ unavailable: "legacyStore" }) })).toEqual({
      kind: "unavailable",
      reason: "legacyStore",
    });
    expect(note({ loadNote: cutOff })?.kind).toBe("cutOff");
  });
});

describe("what a read found", () => {
  // Catches: limits and failures found by reading missing from the note, or a note for a run
  // that is still loading.
  it("keeps only the states that explain missing spans", () => {
    expect(runLoadNote({ state: "unavailable", reason: "noSpans", loadId: 1 })?.kind).toBe(
      "unavailable"
    );
    expect(runLoadNote({ state: "error", message: "x", loadId: 1 })?.kind).toBe("error");
    expect(runLoadNote({ state: "paging", loadId: 1, attempt: 0 })).toBeUndefined();
    expect(runLoadNote({ state: "progressive", loadId: 1 })).toBeUndefined();
  });
});

describe("the run panel's link", () => {
  // Catches: "Open run page" in the panel of a run that never started (its run page 404s).
  it("links to the run page except for a run that never started", () => {
    expect(panelLinksToRunPage(undefined)).toBe(true);
    expect(panelLinksToRunPage({ kind: "starting" })).toBe(true);
    expect(panelLinksToRunPage({ kind: "neverStarted" })).toBe(false);
  });
});

describe("the note for a linked span that never loaded", () => {
  const span = (overrides: Partial<Parameters<typeof spanNotLoaded>[0]> = {}) =>
    spanNotLoaded({
      spanId: "span_1",
      runSpanId: "root_1",
      spanSeen: false,
      runSettled: true,
      onTraceTab: true,
      ...overrides,
    });

  // Catches: a linked span that's past the run's cap or made up leaving the run panel unexplained.
  it("says so once the run's read has ended without the span", () => {
    expect(span()).toBe(true);
  });

  // Catches: the note flashing while later pages are still loading, before the span arrives.
  it("waits while the run is still loading or paging", () => {
    expect(span({ runSettled: false })).toBe(false);
  });

  // Catches: the note staying after the span turned up (a later page, a live tail, a retry).
  it("says nothing once the tree has seen the span", () => {
    expect(span({ spanSeen: true })).toBe(false);
  });

  // Catches: the note on Conversation, where the tree isn't shown.
  it("says nothing off the Trace tab", () => {
    expect(span({ onTraceTab: false })).toBe(false);
  });

  // Catches: a link to the run's own span (common in run page URLs) getting the note, though the
  // run row stands for that span and the run panel shows it.
  it("says nothing for the run's own span", () => {
    expect(span({ spanId: "root_1" })).toBe(false);
  });

  // Catches: a span note on a run selection.
  it("says nothing without a span in the selection", () => {
    expect(span({ spanId: undefined })).toBe(false);
  });
});

describe("whether a run's read has ended", () => {
  // Catches: a run still paging counting as done, so the span note shows before its last page.
  it("is false while queued, loading or paging, true once loaded, cut off, failed or blocked", () => {
    expect(isRunReadSettled({ state: "idle" })).toBe(false);
    expect(isRunReadSettled({ state: "queued" })).toBe(false);
    expect(isRunReadSettled({ state: "loading", loadId: 1 })).toBe(false);
    expect(isRunReadSettled({ state: "paging", loadId: 1, attempt: 0 })).toBe(false);
    expect(isRunReadSettled({ state: "progressive", loadId: 1 })).toBe(true);
    expect(isRunReadSettled({ state: "empty", loadId: 1 })).toBe(true);
    expect(isRunReadSettled({ state: "logsDeleted", loadId: 1 })).toBe(true);
    expect(isRunReadSettled({ state: "error", loadId: 1, message: "x" })).toBe(true);
    expect(
      isRunReadSettled({ state: "cutOff", loadId: 1, limit: "run", started: true, spanLimit: 10 })
    ).toBe(true);
  });
});
