/**
 * The watch card's state machine, kept pure so its rules are testable without a DOM.
 *
 * The card never invents a value the schema would reject: switching condition
 * variant re-clamps the cadence, and the window is always one of the offered
 * options. The option lists are read from contracts (`watchCadenceOptions`,
 * `WATCH_WINDOW_HOURS_OPTIONS`) rather than re-typed, so a picker cannot offer
 * something validation would refuse. Nothing here persists: a draft is client-side
 * until `Start watching` submits it.
 */
import {
  WATCH_DEFAULT_QUEUE_AGE_MINUTES,
  WATCH_DEFAULT_QUEUE_THRESHOLD,
  WATCH_MAX_HOURS,
  WATCH_MAX_QUEUE_AGE_MINUTES,
  WATCH_MAX_QUEUE_THRESHOLD,
  WATCH_STALL_TICKS_DEFAULT,
  WATCH_WINDOW_HOURS_OPTIONS,
  watchCadenceOptions,
  watchConditionVariants,
  watchSpecSchema,
  type WatchDraft,
  type WatchFollowUp,
  type WatchKind,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";
import { noteFor } from "~/presenters/v3/dashboardAgent";

/** A brand-new draft: the recommendation, with both opt-ins off. */
export function watchDraftFor(spec: WatchSpec): WatchDraft {
  return { spec, followUp: { investigateOnAttention: false, notifyExternally: false } };
}

/**
 * The nearest cadence this kind is allowed to poll at. A 1-minute run watch
 * switched to a queue variant must land on 5, not fail validation on submit.
 */
export function clampCadence(kind: WatchKind, minutes: number): number {
  const options = watchCadenceOptions(kind);
  if (options.includes(minutes)) return minutes;
  return options.find((option) => option >= minutes) ?? options[options.length - 1]!;
}

/**
 * Swap the condition for its sibling variant, carrying everything else except the
 * note, which is restated to describe the new condition.
 */
export function withVariant(draft: WatchDraft, kind: WatchKind): WatchDraft {
  const next = variantSpec(draft, kind);
  if (next === draft.spec) return draft;
  return { ...draft, spec: { ...next, note: noteFor(next) } as WatchSpec };
}

function variantSpec(draft: WatchDraft, kind: WatchKind): WatchSpec {
  const { spec } = draft;
  const common = {
    note: spec.note,
    maxHours: spec.maxHours,
    checkEveryMinutes: clampCadence(kind, spec.checkEveryMinutes),
  } as const;

  switch (kind) {
    case "run_finished":
    case "run_failed":
    case "run_start": {
      const runId = "runId" in spec ? spec.runId : "";
      return { ...common, kind, runId } as WatchSpec;
    }
    case "backlog_drain": {
      const queue = "queue" in spec ? spec.queue : "";
      return { ...common, kind, queue } as WatchSpec;
    }
    case "queue_depth_above":
    case "queue_depth_below": {
      const queue = "queue" in spec ? spec.queue : "";
      // The number carries across the two threshold questions: someone who typed
      // 500 for "above" means the same 500 when they flip to "back below".
      const threshold = "threshold" in spec ? spec.threshold : WATCH_DEFAULT_QUEUE_THRESHOLD;
      return { ...common, kind, queue, threshold } as WatchSpec;
    }
    case "queue_stalled": {
      const queue = "queue" in spec ? spec.queue : "";
      // Ticks are not user-facing: the card never shows a field for them.
      const ticks = "ticks" in spec ? spec.ticks : WATCH_STALL_TICKS_DEFAULT;
      return { ...common, kind, queue, ticks } as WatchSpec;
    }
    case "queue_oldest_age": {
      const queue = "queue" in spec ? spec.queue : "";
      const thresholdMinutes =
        "thresholdMinutes" in spec ? spec.thresholdMinutes : WATCH_DEFAULT_QUEUE_AGE_MINUTES;
      return { ...common, kind, queue, thresholdMinutes } as WatchSpec;
    }
    // The kinds with no second question keep the draft untouched.
    default:
      return draft.spec;
  }
}

/**
 * The conditions this draft's picker offers, in order, including the current one.
 * A single-entry list means the kind has no second question and the card states
 * the condition as a fact instead of a choice.
 */
export function variantsOf(draft: WatchDraft): readonly WatchKind[] {
  return watchConditionVariants(draft.spec.kind);
}

export function withCadence(draft: WatchDraft, minutes: number): WatchDraft {
  return {
    ...draft,
    spec: {
      ...draft.spec,
      checkEveryMinutes: clampCadence(draft.spec.kind, minutes),
    } as WatchSpec,
  };
}

export function withWindow(draft: WatchDraft, maxHours: number): WatchDraft {
  const clamped = Math.min(Math.max(maxHours, WATCH_WINDOW_HOURS_OPTIONS[0]), WATCH_MAX_HOURS);
  return { ...draft, spec: { ...draft.spec, maxHours: clamped } as WatchSpec };
}

/**
 * The threshold, as the user is typing it. No range checks here: a half-typed
 * field is a draft, and `watchDraftError` is what refuses to submit it.
 */
export function withThreshold(draft: WatchDraft, threshold: number): WatchDraft {
  if (draft.spec.kind !== "queue_depth_above" && draft.spec.kind !== "queue_depth_below") {
    return draft;
  }
  // The note quotes the number, so a new number restates the note.
  const spec = { ...draft.spec, threshold };
  return { ...draft, spec: { ...spec, note: noteFor(spec) } };
}

/** The age SLA in minutes, as the user is typing it. Same rule as the threshold. */
export function withAgeMinutes(draft: WatchDraft, thresholdMinutes: number): WatchDraft {
  if (draft.spec.kind !== "queue_oldest_age") return draft;
  // The note quotes the number, so a new number restates the note.
  const spec = { ...draft.spec, thresholdMinutes };
  return { ...draft, spec: { ...spec, note: noteFor(spec) } };
}

/**
 * The two follow-up opt-ins, set independently. There is no way to express
 * "external instead of chat": in-chat delivery is not a choice, so it is not here.
 */
export function withFollowUp(draft: WatchDraft, patch: Partial<WatchFollowUp>): WatchDraft {
  return { ...draft, followUp: { ...draft.followUp, ...patch } };
}

/**
 * Why this draft can't be submitted, in the user's words, or null when it can.
 * The schema is the authority, so the card and the server agree by construction;
 * this only translates its refusal into the sentence the card shows inline.
 */
export function watchDraftError(draft: WatchDraft): string | null {
  if (draft.spec.kind === "queue_depth_above" || draft.spec.kind === "queue_depth_below") {
    const { threshold } = draft.spec;
    if (!Number.isInteger(threshold) || threshold < 0) {
      return "Enter a whole number to watch for.";
    }
    if (threshold > WATCH_MAX_QUEUE_THRESHOLD) {
      return `That threshold is too high — ${WATCH_MAX_QUEUE_THRESHOLD.toLocaleString()} is the most a queue watch takes.`;
    }
  }

  if (draft.spec.kind === "queue_oldest_age") {
    const { thresholdMinutes } = draft.spec;
    if (!Number.isInteger(thresholdMinutes) || thresholdMinutes < 1) {
      return "Enter a whole number of minutes to watch for.";
    }
    if (thresholdMinutes > WATCH_MAX_QUEUE_AGE_MINUTES) {
      return `That's longer than a watch can run — ${WATCH_MAX_QUEUE_AGE_MINUTES} minutes is the most.`;
    }
  }

  return watchSpecSchema.safeParse(draft.spec).success
    ? null
    : "Something in this watch isn't valid. Check the duration and the condition.";
}
