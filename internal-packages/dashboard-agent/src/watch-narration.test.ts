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
    // The dashboard's own sentence, the user's reason, then what to do — each once.
    // The banner above the wake carries the label and nothing else.
    expect(plan.text.split("\n\n")).toEqual([
      "task/send-receipt queue drained",
      "You asked to be told when: tell me when the backlog drains",
      "Nothing to do — I've stopped watching it.",
    ]);
  });

  it("needs no model when the answer is that the watched thing is gone", () => {
    const plan = planWatchNarration({ ...DRAINED, resolution: "condition_impossible" });
    expect(plan.model).toBe("none");
    if (plan.model !== "none") throw new Error("unreachable");
    expect(plan.text).toContain("no longer exists");
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

  it("links the watched object once, on the line that acts on it", () => {
    const { text } = deterministicWakeNarration({
      ...DRAINED,
      subjectLink: "[task/send-receipt](trigger://queue/proj_abc/env_abc/task%2Fsend-receipt)",
    });
    expect(text).toContain("I've stopped watching [task/send-receipt]");
    // The headline already names the queue, so it is not followed by the link too.
    expect(text.split("\n\n")[0]).toBe("task/send-receipt queue drained");
    expect(text.match(/trigger:\/\//g)).toHaveLength(1);
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
