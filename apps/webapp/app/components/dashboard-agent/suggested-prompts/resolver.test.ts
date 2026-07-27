import { SUGGESTED_PROMPT_CAP, type SuggestedPrompt } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { demoFreshFailureSignal, demoPageContexts } from "../demo/fixtures/page-context";
import { GENERIC_PROMPTS, pageDefaultPrompts } from "./registry";
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

describe("resolveSuggestedPrompts", () => {
  it("falls back to the generic defaults for an unclassified page with no signals", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.other, { now: NOW });

    expect(ids(prompts)).toEqual(ids(GENERIC_PROMPTS));
    expect(prompts.every((p) => p.source === "default")).toBe(true);
  });

  it("orders promoted, then contextual, then page defaults", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.failedRun, { promoted, now: NOW });

    expect(prompts[0]?.id).toBe(promoted.id);
    expect(prompts[0]?.source).toBe("promoted");
    expect(prompts[1]?.source).toBe("contextual");
    expect(prompts.slice(2).every((p) => p.source === "default")).toBe(true);
  });

  it("puts a fresh failure ahead of every other signal", () => {
    // Queue page: saturation is listed first in the fixture's signals.
    const context = {
      ...demoPageContexts.queue,
      signals: [...demoPageContexts.queue.signals, demoFreshFailureSignal],
    };

    const prompts = resolveSuggestedPrompts(context, { now: NOW });

    expect(prompts[0]?.id).toBe("sp:fresh-failure");
    expect(ids(prompts).indexOf("sp:concurrency-saturation")).toBeGreaterThan(0);
  });

  it("never returns more than the cap", () => {
    for (const context of Object.values(demoPageContexts)) {
      const prompts = resolveSuggestedPrompts(context, { promoted, now: NOW });
      expect(prompts.length).toBeLessThanOrEqual(SUGGESTED_PROMPT_CAP);
      expect(prompts.length).toBeGreaterThan(0);
    }
  });

  it("fills the row to the cap when there are enough candidates", () => {
    const prompts = resolveSuggestedPrompts(demoPageContexts.failedRun, { promoted, now: NOW });
    expect(prompts).toHaveLength(SUGGESTED_PROMPT_CAP);
  });

  it("drops dismissed chips and pulls the next candidate up", () => {
    const full = resolveSuggestedPrompts(demoPageContexts.runs, { now: NOW });
    const dismissed = resolveSuggestedPrompts(demoPageContexts.runs, {
      now: NOW,
      dismissedIds: [full[0]!.id],
    });

    expect(ids(dismissed)).not.toContain(full[0]!.id);
    // Still capped, and the row didn't shrink — a new candidate took the slot.
    expect(dismissed).toHaveLength(full.length);
    expect(ids(dismissed)).not.toEqual(ids(full));
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
    const prompts = resolveSuggestedPrompts(demoPageContexts.other, {
      promoted: { ...GENERIC_PROMPTS[1]!, source: "default" },
      now: NOW,
    });

    expect(ids(prompts).filter((id) => id === GENERIC_PROMPTS[1]!.id)).toHaveLength(1);
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

  it("describes a waiting run and a slow run in their chips", () => {
    const waiting = resolveSuggestedPrompts(demoPageContexts.waitingRun, { now: NOW });
    expect(waiting[0]?.label).toBe("Why is this run waiting?");
    expect(waiting[0]?.prompt).toContain("queue");

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

describe("pageDefaultPrompts", () => {
  it("gives every page kind a non-empty, uniquely-identified set", () => {
    const pages = Object.values(demoPageContexts).map((context) => context.page);

    for (const page of pages) {
      const prompts = pageDefaultPrompts(page);
      expect(prompts.length, page.kind).toBeGreaterThan(0);
      expect(new Set(ids(prompts)).size, page.kind).toBe(prompts.length);
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
