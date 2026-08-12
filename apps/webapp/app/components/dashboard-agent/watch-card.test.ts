import { describe, expect, it } from "vitest";
import {
  WATCH_MAX_QUEUE_AGE_MINUTES,
  WATCH_MAX_QUEUE_THRESHOLD,
  WATCH_STALL_TICKS_DEFAULT,
  watchSpecSchema,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { OLDEST_WAIT_WARNING_MS } from "~/components/queues/queue-thresholds";
import {
  clampCadence,
  variantsOf,
  watchDraftError,
  watchDraftFor,
  withAgeMinutes,
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
} from "~/presenters/v3/dashboardAgent";
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
    expect(queueWatchRecommendation("email-sends").kind).toBe("queue_oldest_age");
    expect(errorWatchRecommendation("error_a1b2c3d4").kind).toBe("error_recurrence");
    expect(healthWatchRecommendation("warn").kind).toBe("health_recovery");
  });

  it("switches the queue recommendation to the drain once runs are already late", () => {
    const late = queueWatchRecommendation("email-sends", {
      oldestWaitMs: OLDEST_WAIT_WARNING_MS,
    });
    expect(late).toMatchObject({
      kind: "backlog_drain",
      queue: "email-sends",
    });
    expect(watchSpecSchema.safeParse(late).success).toBe(true);
  });

  it("stays on the age SLA when the queue is merely busy, or the signal is missing", () => {
    expect(
      queueWatchRecommendation("email-sends", { oldestWaitMs: OLDEST_WAIT_WARNING_MS - 1 }).kind
    ).toBe("queue_oldest_age");
    expect(queueWatchRecommendation("email-sends", { oldestWaitMs: null }).kind).toBe(
      "queue_oldest_age"
    );
    expect(queueWatchRecommendation("email-sends", {}).kind).toBe("queue_oldest_age");
    expect(queueWatchRecommendation("email-sends").kind).toBe("queue_oldest_age");
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
    const swapped = withVariant(withCadence(runDraft(), 1), "backlog_drain");
    expect(swapped.spec.checkEveryMinutes).toBe(5);
    expect(watchSpecSchema.safeParse(swapped.spec).success).toBe(true);
  });
});

describe("condition variants (§3)", () => {
  it("offers the whole run family and the whole queue family", () => {
    expect(variantsOf(runDraft())).toEqual(["run_start", "run_finished", "run_failed"]);
    expect(variantsOf(queueDraft())).toEqual([
      "backlog_drain",
      "queue_depth_above",
      "queue_depth_below",
      "queue_stalled",
      "queue_oldest_age",
    ]);
    expect(variantsOf(watchDraftFor(errorWatchRecommendation("error_a1")))).toHaveLength(1);
    expect(variantsOf(watchDraftFor(healthWatchRecommendation("warn")))).toHaveLength(1);
  });

  it("carries the subject and window across a swap, and restates the note", () => {
    const draft = withWindow(runDraft(), 6);
    const failed = withVariant(draft, "run_failed");
    expect(failed.spec).toMatchObject({
      kind: "run_failed",
      runId: "run_abc123",
      maxHours: 6,
      note: "tell me if run run_abc123 fails",
    });
  });

  it("restates the note when the threshold number changes", () => {
    const above = withThreshold(withVariant(queueDraft(), "queue_depth_above"), 500);
    // Same verb and same SLA format as the card's condition line: both come from
    // the presenter's one wording record.
    expect(above.spec.note).toBe("tell me if the email-sends queue goes above 500");
    const age = withAgeMinutes(withVariant(queueDraft(), "queue_oldest_age"), 90);
    expect(age.spec.note).toBe("tell me if runs in email-sends wait longer than 1h 30m");
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

  it("gives every queue variant a submittable default and keeps the subject", () => {
    for (const kind of [
      "queue_depth_above",
      "queue_depth_below",
      "queue_stalled",
      "queue_oldest_age",
    ] as const) {
      const swapped = withVariant(queueDraft(), kind);
      expect(swapped.spec).toMatchObject({ kind, queue: "email-sends" });
      expect(watchDraftError(swapped)).toBeNull();
      expect(watchSpecSchema.safeParse(swapped.spec).success).toBe(true);
    }
  });

  it("carries a typed threshold between the two threshold questions", () => {
    const above = withThreshold(withVariant(queueDraft(), "queue_depth_above"), 500);
    const below = withVariant(above, "queue_depth_below");
    expect(below.spec).toMatchObject({ kind: "queue_depth_below", threshold: 500 });
  });

  it("keeps the stall count internal — the default, never a field", () => {
    const stalled = withVariant(queueDraft(), "queue_stalled");
    expect(stalled.spec).toMatchObject({ ticks: WATCH_STALL_TICKS_DEFAULT });
    expect(withThreshold(stalled, 5)).toEqual(stalled);
    expect(withAgeMinutes(stalled, 5)).toEqual(stalled);
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

  it("refuses a half-typed threshold on the `below` variant too", () => {
    const draft = withThreshold(withVariant(queueDraft(), "queue_depth_below"), Number.NaN);
    expect(watchDraftError(draft)).toMatch(/whole number/i);
  });

  it("refuses an SLA that is empty, zero, or longer than a watch can run", () => {
    const age = withVariant(queueDraft(), "queue_oldest_age");
    expect(watchDraftError(withAgeMinutes(age, Number.NaN))).toMatch(/whole number of minutes/i);
    expect(watchDraftError(withAgeMinutes(age, 0))).toMatch(/whole number of minutes/i);
    expect(watchDraftError(withAgeMinutes(age, WATCH_MAX_QUEUE_AGE_MINUTES + 1))).toMatch(
      /longer than a watch can run/i
    );
    expect(watchDraftError(withAgeMinutes(age, 30))).toBeNull();
  });

  it("ignores an SLA set on a kind that has none", () => {
    expect(withAgeMinutes(runDraft(), 5)).toEqual(runDraft());
  });
});

describe("the card's copy", () => {
  it("names the subject the way the object does", () => {
    expect(watchSubjectLabel(queueWatchRecommendation("email-sends"))).toBe("email-sends");
    expect(watchSubjectLabel(runWatchRecommendation("run_abc123"))).toBe("run run_abc123");
    expect(watchSubjectLabel(healthWatchRecommendation("warn"))).toBe("health");
  });

  it("says the kind once, and names the error in full", () => {
    // Fingerprints are stored prefixed (`error_c4b4a797397a9c43`), so the raw value
    // would read "error error_c4b4a797397a9c43".
    expect(
      watchSubjectLabel({
        kind: "error_recurrence",
        fingerprint: "error_c4b4a797397a9c43",
        checkEveryMinutes: 5,
        maxHours: 0.5,
      })
    ).toBe("error c4b4a797397a9c43");
  });

  it("states the condition and the duration as §2.2 writes them", () => {
    const spec = queueWatchRecommendation("email-sends", { oldestWaitMs: OLDEST_WAIT_WARNING_MS });
    expect(watchConditionLabel(spec)).toBe("Until the queue drains");
    expect(watchDurationLabel(spec)).toBe("For 1 hour · checking every 5 min");
  });

  it("carries the threshold into the condition line", () => {
    const above = withThreshold(withVariant(queueDraft(), "queue_depth_above"), 500);
    expect(watchConditionLabel(above.spec)).toBe("If the queue goes above 500");
  });

  it("states each new queue condition the way the user reads it", () => {
    const below = withThreshold(withVariant(queueDraft(), "queue_depth_below"), 100);
    expect(watchConditionLabel(below.spec)).toBe("Until the queue is back below 100");

    const stalled = withVariant(queueDraft(), "queue_stalled");
    expect(watchConditionLabel(stalled.spec)).toBe("If the queue stops moving");

    const age = withAgeMinutes(withVariant(queueDraft(), "queue_oldest_age"), 90);
    expect(watchConditionLabel(age.spec)).toBe("If runs wait longer than 1h 30m");
    expect(watchSubjectLabel(age.spec)).toBe("email-sends");
  });

  it("writes the confirmation as one sentence for every queue condition", () => {
    const stalled = withVariant(queueDraft(), "queue_stalled");
    expect(watchConfirmationBlockBody({ spec: stalled.spec, watchId: "w" }).headline).toBe(
      "Watching email-sends in case it stops moving."
    );

    const age = withAgeMinutes(withVariant(queueDraft(), "queue_oldest_age"), 5);
    expect(watchConfirmationBlockBody({ spec: age.spec, watchId: "w" }).headline).toBe(
      "Watching email-sends in case runs wait longer than 5m."
    );

    const below = withThreshold(withVariant(queueDraft(), "queue_depth_below"), 100);
    expect(watchConfirmationBlockBody({ spec: below.spec, watchId: "w" }).headline).toBe(
      "Watching email-sends until it is back below 100."
    );
  });
});

describe("the persisted blocks (§2.2)", () => {
  it("states all four lifetime facts on a confirmation", () => {
    const body = watchConfirmationBlockBody({
      spec: queueWatchRecommendation("email-sends", { oldestWaitMs: OLDEST_WAIT_WARNING_MS }),
      watchId: "watch_1",
    });
    expect(body.outcome).toBe("watching");
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
      followUp: { investigateOnAttention: true, external: { status: "not_requested" } },
    });
    expect(body.followUp).toEqual(["If it turns out badly, I'll investigate straight away."]);
  });

  it("says out loud when the email the user asked for couldn't be added", () => {
    const body = watchConfirmationBlockBody({
      spec: queueWatchRecommendation("email-sends"),
      watchId: "watch_1",
      followUp: { external: { status: "unavailable", reason: "email_alerts_not_configured" } },
    });
    expect(body.followUp).toEqual([
      "I couldn't add email notifications, so updates will appear in the dashboard only.",
    ]);
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
