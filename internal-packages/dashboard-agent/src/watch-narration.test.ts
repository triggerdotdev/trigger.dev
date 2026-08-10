import { describe, expect, it } from "vitest";
import {
  deterministicWakeNarration,
  planWatchNarration,
  type NarratableWake,
} from "./watch-narration";

const DRAINED: NarratableWake = {
  kind: "backlog_drain",
  identity: "backlog_drain:task/send-receipt",
  resolution: "condition_met",
  observed: { kind: "backlog_drain", verified: true, depth: 0 },
  note: "tell me when the backlog drains",
  startsInvestigation: false,
};

const STALLED: NarratableWake = {
  kind: "queue_stalled",
  identity: "queue_stalled:task/send-receipt",
  resolution: "condition_met",
  observed: {
    kind: "queue_stalled",
    verified: true,
    depth: 412,
    ticks: 4,
    notDecreasingStreak: 4,
  },
  startsInvestigation: false,
};

describe("which model narrates a wake", () => {
  it("needs no model for a condition that simply became true", () => {
    const plan = planWatchNarration(DRAINED);
    expect(plan.model).toBe("none");
    if (plan.model !== "none") throw new Error("unreachable");
    // Just what to do. The banner above the wake already states the headline and
    // the user's reason, and a wake says each fact once.
    expect(plan.text).toBe("Nothing to do — I've stopped watching.");
    expect(plan.presentation.headline).toBe("task/send-receipt queue drained");
  });

  it("needs no model when the answer is that the watched thing is gone", () => {
    const plan = planWatchNarration({ ...DRAINED, resolution: "condition_impossible" });
    expect(plan.model).toBe("none");
    if (plan.model !== "none") throw new Error("unreachable");
    expect(plan.presentation.headline).toContain("no longer exists");
  });

  it("never repeats the headline or the note the banner already states", () => {
    const { text } = deterministicWakeNarration(DRAINED);
    expect(text).not.toContain("queue drained");
    expect(text).not.toContain("tell me when the backlog drains");
    expect(text).not.toContain("You asked to be told when");
  });

  it("uses Haiku when the fact has to be turned into what to do", () => {
    expect(planWatchNarration(STALLED).model).toBe("haiku");
    // A window that ran out with the queue still backed up is the same judgement.
    expect(planWatchNarration({ ...DRAINED, resolution: "window_completed" }).model).toBe("haiku");
  });

  it("keeps Sonnet for the consented investigation, whatever the outcome", () => {
    expect(planWatchNarration({ ...STALLED, startsInvestigation: true }).model).toBe("sonnet");
    expect(planWatchNarration({ ...DRAINED, startsInvestigation: true }).model).toBe("sonnet");
  });

  it("never names the watched object again — the banner just named it", () => {
    const { text } = deterministicWakeNarration(DRAINED);
    expect(text).not.toContain("task/send-receipt");
    expect(text).not.toContain("trigger://");
  });

  it("never says fired or expired", () => {
    for (const resolution of [
      "condition_met",
      "window_completed",
      "condition_impossible",
    ] as const) {
      const { text } = deterministicWakeNarration({ ...DRAINED, resolution });
      expect(text).not.toMatch(/fired|expired/);
    }
  });
});
