import { describe, expect, it } from "vitest";
import {
  WATCH_MAX_QUEUE_THRESHOLD,
  watchSpecSchema,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import {
  clampCadence,
  variantOf,
  watchDraftError,
  watchDraftFor,
  withCadence,
  withFollowUp,
  withThreshold,
  withVariant,
  withWindow,
} from "./watch-card";
import {
  watchConditionLabel,
  watchConfirmationBlockBody,
  watchDurationLabel,
  watchOneShotBlockBody,
  watchSubjectLabel,
} from "./watch-presentation";
import {
  errorWatchRecommendation,
  healthWatchRecommendation,
  queueWatchRecommendation,
  runWatchRecommendation,
} from "./watch-recommendations";

const queueDraft = () => watchDraftFor(queueWatchRecommendation("email-sends"));
const runDraft = () => watchDraftFor(runWatchRecommendation("run_abc123"));

describe("the recommendations", () => {
  it("gives every entry point a spec the schema accepts", () => {
    const specs: WatchSpec[] = [
      runWatchRecommendation("run_abc123"),
      queueWatchRecommendation("email-sends"),
      errorWatchRecommendation("error_a1b2c3d4"),
      healthWatchRecommendation("crit"),
    ];
    for (const spec of specs) {
      expect(watchSpecSchema.safeParse(spec).success).toBe(true);
    }
  });

  it("recommends the condition §2.1 assigns to each object", () => {
    expect(runWatchRecommendation("run_abc123").kind).toBe("run_finished");
    expect(queueWatchRecommendation("email-sends").kind).toBe("backlog_drain");
    expect(errorWatchRecommendation("error_a1b2c3d4").kind).toBe("error_recurrence");
    expect(healthWatchRecommendation("warn").kind).toBe("health_recovery");
  });

  it("starts both follow-ups off — consent is never assumed", () => {
    expect(runDraft().followUp).toEqual({
      investigateOnAttention: false,
      notifyExternally: false,
    });
  });
});

describe("cadence limits", () => {
  it("lets a run watch poll every minute", () => {
    expect(clampCadence("run_finished", 1)).toBe(1);
  });

  it("floors an aggregate watch at five minutes — never a hot loop", () => {
    expect(clampCadence("backlog_drain", 1)).toBe(5);
    expect(clampCadence("queue_depth_above", 1)).toBe(5);
    expect(clampCadence("health_recovery", 1)).toBe(5);
  });

  it("keeps an offered cadence and rounds an unknown one up", () => {
    expect(clampCadence("backlog_drain", 15)).toBe(15);
    expect(clampCadence("backlog_drain", 7)).toBe(15);
    expect(clampCadence("backlog_drain", 999)).toBe(60);
  });

  it("re-clamps when the kind changes under the user", () => {
    // A 1-minute run watch switched to the queue variant must LAND on 5, not
    // carry a cadence the aggregate schema would then reject.
    const swapped = withVariant(withCadence(runDraft(), 1), "backlog_drain");
    expect(swapped.spec.checkEveryMinutes).toBe(5);
    expect(watchSpecSchema.safeParse(swapped.spec).success).toBe(true);
  });
});

describe("condition variants (§3)", () => {
  it("pairs the two run questions and the two queue questions", () => {
    expect(variantOf(runDraft())).toBe("run_failed");
    expect(variantOf(queueDraft())).toBe("queue_depth_above");
    expect(variantOf(watchDraftFor(errorWatchRecommendation("error_a1")))).toBeNull();
    expect(variantOf(watchDraftFor(healthWatchRecommendation("warn")))).toBeNull();
  });

  it("carries the subject, window and note across a swap", () => {
    const draft = withWindow(runDraft(), 6);
    const failed = withVariant(draft, "run_failed");
    expect(failed.spec).toMatchObject({
      kind: "run_failed",
      runId: "run_abc123",
      maxHours: 6,
      note: draft.spec.note,
    });
  });

  it("gives the threshold variant a usable default", () => {
    const above = withVariant(queueDraft(), "queue_depth_above");
    expect(above.spec).toMatchObject({ kind: "queue_depth_above", queue: "email-sends" });
    expect(watchDraftError(above)).toBeNull();
  });

  it("swaps back without losing the queue", () => {
    const roundTrip = withVariant(withVariant(queueDraft(), "queue_depth_above"), "backlog_drain");
    expect(roundTrip.spec).toMatchObject({ kind: "backlog_drain", queue: "email-sends" });
  });
});

describe("the window", () => {
  it("never leaves the 24-hour ceiling", () => {
    expect(withWindow(runDraft(), 999).spec.maxHours).toBe(24);
  });

  it("never goes below the shortest offered window", () => {
    expect(withWindow(runDraft(), 0).spec.maxHours).toBe(0.5);
  });
});

describe("the follow-up opt-ins (§2.2, binding)", () => {
  it("sets them INDEPENDENTLY — never as a radio group", () => {
    const both = withFollowUp(withFollowUp(runDraft(), { notifyExternally: true }), {
      investigateOnAttention: true,
    });
    expect(both.followUp).toEqual({ investigateOnAttention: true, notifyExternally: true });
  });

  it("turning one off leaves the other alone", () => {
    const draft = withFollowUp(runDraft(), {
      investigateOnAttention: true,
      notifyExternally: true,
    });
    expect(withFollowUp(draft, { notifyExternally: false }).followUp).toEqual({
      investigateOnAttention: true,
      notifyExternally: false,
    });
  });

  it("has no way to express in-chat delivery at all — it is not a choice", () => {
    expect(Object.keys(runDraft().followUp).sort()).toEqual([
      "investigateOnAttention",
      "notifyExternally",
    ]);
  });
});

describe("validation stays inside the card", () => {
  it("accepts every recommendation as it opens", () => {
    expect(watchDraftError(runDraft())).toBeNull();
    expect(watchDraftError(queueDraft())).toBeNull();
  });

  it("refuses a half-typed threshold", () => {
    const draft = withThreshold(withVariant(queueDraft(), "queue_depth_above"), Number.NaN);
    expect(watchDraftError(draft)).toMatch(/whole number/i);
  });

  it("refuses a threshold above the queue-watch ceiling", () => {
    const draft = withThreshold(
      withVariant(queueDraft(), "queue_depth_above"),
      WATCH_MAX_QUEUE_THRESHOLD + 1
    );
    expect(watchDraftError(draft)).toMatch(/too high/i);
  });

  it("ignores a threshold set on a kind that has none", () => {
    expect(withThreshold(runDraft(), 5)).toEqual(runDraft());
  });
});

describe("the card's copy", () => {
  it("names the subject the way the object does", () => {
    expect(watchSubjectLabel(queueWatchRecommendation("email-sends"))).toBe("email-sends");
    expect(watchSubjectLabel(runWatchRecommendation("run_abc123"))).toBe("run run_abc123");
    expect(watchSubjectLabel(healthWatchRecommendation("warn"))).toBe("health");
  });

  it("states the condition and the duration as §2.2 writes them", () => {
    const spec = queueWatchRecommendation("email-sends");
    expect(watchConditionLabel(spec)).toBe("Until the queue drains");
    expect(watchDurationLabel(spec)).toBe("For 1 hour · checking every 5 min");
  });

  it("carries the threshold into the condition line", () => {
    const above = withThreshold(withVariant(queueDraft(), "queue_depth_above"), 500);
    expect(watchConditionLabel(above.spec)).toBe("If the queue goes above 500");
  });
});

describe("the persisted blocks (§2.2)", () => {
  it("states all four lifetime facts on a confirmation", () => {
    const body = watchConfirmationBlockBody({
      spec: queueWatchRecommendation("email-sends"),
      watchId: "watch_1",
    });
    expect(body.outcome).toBe("watching");
    // what · how often it checks · that it reports once · when it gives up
    expect(body.headline).toBe("Watching email-sends until the queue drains.");
    expect(body.lifetime).toBe(
      "Checking every 5 min for up to 1 hour. It reports once, then stops."
    );
    expect(body.watchId).toBe("watch_1");
    expect(body.detail).toBeNull();
  });

  it("says plainly when the creation-time check couldn't run", () => {
    const body = watchConfirmationBlockBody({
      spec: queueWatchRecommendation("email-sends"),
      watchId: "watch_1",
      unavailable: true,
    });
    expect(body.detail).toBe("We couldn't check that just now. Watching anyway.");
  });

  it("only claims a follow-up that actually took effect", () => {
    const body = watchConfirmationBlockBody({
      spec: queueWatchRecommendation("email-sends"),
      watchId: "watch_1",
      followUp: { investigateOnAttention: true, notifyExternally: false },
    });
    expect(body.followUp).toEqual(["If it turns out badly, I'll investigate straight away."]);
  });

  it("makes a one-shot result carry no lifetime and no watch", () => {
    const satisfied = watchOneShotBlockBody({
      spec: queueWatchRecommendation("email-sends"),
      result: "satisfied",
    });
    expect(satisfied.outcome).toBe("already_true");
    expect(satisfied.headline).toBe("That already happened, so there's nothing left to watch.");
    expect(satisfied.lifetime).toBeNull();
    expect(satisfied.watchId).toBeNull();

    const impossible = watchOneShotBlockBody({
      spec: runWatchRecommendation("run_abc123"),
      result: "terminal_unsatisfied",
    });
    expect(impossible.outcome).toBe("impossible");
    expect(impossible.headline).toBe("That can't happen any more, so there's nothing to watch.");
  });
});
