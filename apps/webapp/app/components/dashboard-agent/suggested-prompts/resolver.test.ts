import { SUGGESTED_PROMPT_CAP, type SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { demoFreshFailureSignal, demoPageContexts } from "../demo/fixtures/page-context";
import { GENERIC_PROMPTS, pageDefaultPrompts, pageSlotPrompts } from "./registry";
import { makeSuggestedPromptResolver, resolveSuggestedPrompts } from "./resolver";

/** Fixed clock: "failed 12 minutes after the fixture's failedAt". */
const NOW = Date.parse("2026-07-27T10:25:41.000Z");

const promoted: SuggestedPrompt = {
  id: "sp:promo-blackfriday",
  label: "Check the Black Friday queue",
  prompt: "How is the black-friday queue holding up?",
  source: "default", // deliberately wrong — the resolver must force `promoted`
};

const ids = (prompts: SuggestedPrompt[]) => prompts.map((p) => p.id);

/** The docs chip for a page — always the last slot. */
const docsId = (key: keyof typeof demoPageContexts) =>
  pageSlotPrompts(demoPageContexts[key].page).docs.id;

describe("resolveSuggestedPrompts", () => {
  it("fills all five slots when the page has a promoted chip, signals and defaults", () => {
    // Error page: investigate + watch + explain + docs defaults, plus a fresh
    // failure signal that takes the investigate slot.
    const prompts = resolveSuggestedPrompts(demoPageContexts.error, { promoted, now: NOW });

    expect(prompts).toHaveLength(5);
    expect(ids(prompts)).toEqual([
      promoted.id,
      "sp:fresh-failure",
      "sp:error-watch-recurrence",
      "sp:error-similar",
      docsId("error"),
    ]);
    expect(prompts[0]?.source).toBe("promoted");
  });

  it("drops to four slots when nothing is promoted", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.error, { now: NOW });

    expect(prompts).toHaveLength(4);
    expect(ids(prompts)).toEqual([
      "sp:fresh-failure",
      "sp:error-watch-recurrence",
      "sp:error-similar",
      docsId("error"),
    ]);
  });

  it("shows explain + docs only when no investigate or watch applies", () => {
    // A deployment page has no failure to dig into and nothing to watch.
    const prompts = resolveSuggestedPrompts(demoPageContexts.deployment, { now: NOW });

    expect(ids(prompts)).toEqual(ids(pageDefaultPrompts(demoPageContexts.deployment.page)));
    expect(prompts).toHaveLength(2);
    expect(prompts.every((p) => p.source === "default")).toBe(true);
  });

  it("falls back to the generic explain + docs pair for an unclassified page", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.other, { now: NOW });

    expect(ids(prompts)).toEqual(ids(GENERIC_PROMPTS));
    expect(prompts.every((p) => p.source === "default")).toBe(true);
  });

  it("always puts the docs chip last, on every page kind", () => {
    for (const [key, context] of Object.entries(demoPageContexts)) {
      const prompts = resolveSuggestedPrompts(context, { promoted, now: NOW });
      const last = prompts.at(-1);

      expect(last?.id, key).toBe(docsId(key as keyof typeof demoPageContexts));
      expect(
        prompts.filter((p) => p.id === last?.id),
        key
      ).toHaveLength(1);
    }
  });

  it("orders promoted, then investigate, then watch, then explain", () => {
    // Queue page: saturation fills watch, the fresh failure fills investigate.
    const context = {
      ...demoPageContexts.queue,
      signals: [...demoPageContexts.queue.signals, demoFreshFailureSignal],
    };

    const prompts = resolveSuggestedPrompts(context, { promoted, now: NOW });

    expect(ids(prompts)).toEqual([
      promoted.id,
      "sp:fresh-failure",
      // waiting_run beats concurrency_saturation for the watch slot.
      "sp:waiting-run",
      "sp:queue-state",
      docsId("queue"),
    ]);
  });

  it("gives a signal chip the slot ahead of the page-kind default", () => {
    // The failed-run page can fill investigate itself; the fresh failure wins.
    const prompts = resolveSuggestedPrompts(demoPageContexts.failedRun, { now: NOW });

    expect(prompts[0]?.id).toBe("sp:fresh-failure");
    expect(prompts[0]?.source).toBe("contextual");
    expect(ids(prompts)).not.toContain("sp:run-investigate");
  });

  it("never returns more than the cap", () => {
    for (const context of Object.values(demoPageContexts)) {
      const prompts = resolveSuggestedPrompts(context, { promoted, now: NOW });
      expect(prompts.length).toBeLessThanOrEqual(SUGGESTED_PROMPT_CAP);
      expect(prompts.length).toBeGreaterThan(0);
    }
  });

  it("promotes the next candidate for a slot when its chip is dismissed", () => {
    const full = resolveSuggestedPrompts(demoPageContexts.failedRun, { now: NOW });
    const dismissed = resolveSuggestedPrompts(demoPageContexts.failedRun, {
      now: NOW,
      dismissedIds: ["sp:fresh-failure"],
    });

    expect(ids(full)[0]).toBe("sp:fresh-failure");
    // The run page's own investigate default takes the vacated slot.
    expect(ids(dismissed)[0]).toBe("sp:run-investigate");
    expect(dismissed).toHaveLength(full.length);
  });

  it("collapses a slot with nothing left to offer", () => {
    const full = resolveSuggestedPrompts(demoPageContexts.error, { now: NOW });
    const dismissed = resolveSuggestedPrompts(demoPageContexts.error, {
      now: NOW,
      dismissedIds: ["sp:error-watch-recurrence"],
    });

    expect(ids(dismissed)).not.toContain("sp:error-watch-recurrence");
    expect(dismissed).toHaveLength(full.length - 1);
    // Docs is still last.
    expect(dismissed.at(-1)?.id).toBe(docsId("error"));
  });

  it("can have the promoted chip dismissed like any other", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.runs, {
      promoted,
      now: NOW,
      dismissedIds: [promoted.id],
    });

    expect(ids(prompts)).not.toContain(promoted.id);
  });

  it("de-duplicates a chip that is both a default and the promoted slot", () => {
    const explain = pageSlotPrompts(demoPageContexts.other.page).explain;
    const prompts = resolveSuggestedPrompts(demoPageContexts.other, {
      promoted: { ...explain, source: "default" },
      now: NOW,
    });

    expect(ids(prompts).filter((id) => id === explain.id)).toHaveLength(1);
    expect(prompts[0]?.source).toBe("promoted");
  });

  it("sends the full prompt text, not the short label", () => {
    const [failure] = resolveSuggestedPrompts(demoPageContexts.failedRun, { now: NOW });

    expect(failure?.label).toBe("Why did this run fail?");
    expect(failure?.prompt).toContain(
      demoPageContexts.failedRun.page.kind === "run" ? demoPageContexts.failedRun.page.runId : ""
    );
    expect(failure?.prompt).toContain("12m ago");
  });

  it("words the waiting-run and slow-run chips for their slots", () => {
    const waiting = resolveSuggestedPrompts(demoPageContexts.waitingRun, { now: NOW });
    const waitingChip = waiting.find((p) => p.id === "sp:waiting-run");
    expect(waitingChip?.label).toBe("Tell me when this run starts");
    expect(waitingChip?.prompt).toContain("queue");

    const slow = resolveSuggestedPrompts(demoPageContexts.slowRun, { now: NOW });
    expect(slow[0]?.label).toBe("~7.8x slower than usual");
  });

  it("skips a slow_run signal with no usable baseline", () => {
    const prompts = resolveSuggestedPrompts(
      {
        page: { kind: "other", path: "/whatever" },
        signals: [{ kind: "slow_run", runId: "run_x", durationMs: 5000, baselineP95Ms: 0 }],
      },
      { now: NOW }
    );

    expect(ids(prompts)).toEqual(ids(GENERIC_PROMPTS));
  });

  it("exposes the contract's resolver shape with options bound", () => {
    const resolver = makeSuggestedPromptResolver({ promoted, now: NOW });
    expect(resolver(demoPageContexts.failedRun)[0]?.id).toBe(promoted.id);
  });
});

describe("pageSlotPrompts", () => {
  it("gives every page kind an explain and a docs chip", () => {
    for (const context of Object.values(demoPageContexts)) {
      const slots = pageSlotPrompts(context.page);
      expect(slots.explain.label, context.page.kind).toBeTruthy();
      expect(slots.docs.label, context.page.kind).toBeTruthy();
    }
  });

  it("gives every page kind a non-empty, uniquely-identified default set", () => {
    for (const context of Object.values(demoPageContexts)) {
      const prompts = pageDefaultPrompts(context.page);
      expect(prompts.length, context.page.kind).toBeGreaterThan(0);
      expect(new Set(ids(prompts)).size, context.page.kind).toBe(prompts.length);
      // Docs is always the tail of the page's own set too.
      expect(prompts.at(-1)?.id, context.page.kind).toBe(pageSlotPrompts(context.page).docs.id);
    }
  });

  it("mentions the page's own subject where the page has one", () => {
    const runPage = demoPageContexts.failedRun.page;
    if (runPage.kind !== "run") throw new Error("fixture changed");
    expect(pageDefaultPrompts(runPage).some((p) => p.prompt.includes(runPage.runId))).toBe(true);
    expect(pageDefaultPrompts(runPage).some((p) => p.prompt.includes(runPage.taskId))).toBe(true);

    const queuePage = demoPageContexts.queue.page;
    if (queuePage.kind !== "queue") throw new Error("fixture changed");
    expect(pageDefaultPrompts(queuePage).some((p) => p.prompt.includes(queuePage.name))).toBe(true);
  });
});
