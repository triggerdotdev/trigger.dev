/**
 * The watch card's state machine — pure, so every rule the card enforces is
 * testable without a DOM.
 *
 * The card never invents a value the schema would then reject: switching to a
 * condition variant re-clamps the cadence (an aggregate kind is floored at 5
 * minutes), and the window is always one of the offered options. That is why the
 * option lists live in contracts (`watchCadenceOptions`, `WATCH_WINDOW_HOURS_OPTIONS`)
 * and are read from here rather than re-typed: a picker can't offer something
 * validation would refuse.
 *
 * Nothing here persists anything. A draft is client-side until `Start watching`
 * submits it (§2.2, transcript hygiene).
 */
import {
  WATCH_DEFAULT_QUEUE_THRESHOLD,
  WATCH_MAX_HOURS,
  WATCH_MAX_QUEUE_THRESHOLD,
  WATCH_WINDOW_HOURS_OPTIONS,
  watchCadenceOptions,
  watchSpecSchema,
  watchVariantKind,
  type WatchDraft,
  type WatchFollowUp,
  type WatchKind,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";

/** A brand-new draft: the recommendation, with both opt-ins off (§6). */
export function watchDraftFor(spec: WatchSpec): WatchDraft {
  return { spec, followUp: { investigateOnAttention: false, notifyExternally: false } };
}

/**
 * The nearest cadence this kind is allowed to poll at. Used whenever the kind
 * changes under the user: a 1-minute run watch switched to a queue variant must
 * land on 5, not fail validation on submit.
 */
export function clampCadence(kind: WatchKind, minutes: number): number {
  const options = watchCadenceOptions(kind);
  if (options.includes(minutes)) return minutes;
  return options.find((option) => option >= minutes) ?? options[options.length - 1]!;
}

/** Swap the condition for its sibling variant (§3), carrying everything else. */
export function withVariant(draft: WatchDraft, kind: WatchKind): WatchDraft {
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
      return { ...draft, spec: { ...common, kind, runId } as WatchSpec };
    }
    case "backlog_drain": {
      const queue = "queue" in spec ? spec.queue : "";
      return { ...draft, spec: { ...common, kind, queue } as WatchSpec };
    }
    case "queue_depth_above": {
      const queue = "queue" in spec ? spec.queue : "";
      const threshold = "threshold" in spec ? spec.threshold : WATCH_DEFAULT_QUEUE_THRESHOLD;
      return { ...draft, spec: { ...common, kind, queue, threshold } as WatchSpec };
    }
    // The kinds with no second question keep the draft untouched.
    default:
      return draft;
  }
}

/** The sibling this draft can toggle to, or null when the kind has none. */
export function variantOf(draft: WatchDraft): WatchKind | null {
  return watchVariantKind(draft.spec.kind);
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
 * The threshold, as the user is typing it. Kept out of range checks on purpose —
 * an empty or half-typed field is not an error yet, it is a draft; `watchDraftError`
 * is what refuses to submit one.
 */
export function withThreshold(draft: WatchDraft, threshold: number): WatchDraft {
  if (draft.spec.kind !== "queue_depth_above") return draft;
  return { ...draft, spec: { ...draft.spec, threshold } };
}

/**
 * The two follow-up opt-ins, set INDEPENDENTLY (§2.2, binding). There is
 * deliberately no way to express "external instead of chat": in-chat delivery is
 * not in this shape at all, because it is not a choice.
 */
export function withFollowUp(draft: WatchDraft, patch: Partial<WatchFollowUp>): WatchDraft {
  return { ...draft, followUp: { ...draft.followUp, ...patch } };
}

/**
 * Why this draft can't be submitted, in the user's words — or null when it can.
 *
 * The schema is the authority (so the card and the server agree by construction);
 * this only translates its refusal into the one sentence the card shows inline.
 */
export function watchDraftError(draft: WatchDraft): string | null {
  if (draft.spec.kind === "queue_depth_above") {
    const { threshold } = draft.spec;
    if (!Number.isInteger(threshold) || threshold < 0) {
      return "Enter a whole number to watch for.";
    }
    if (threshold > WATCH_MAX_QUEUE_THRESHOLD) {
      return `That threshold is too high — ${WATCH_MAX_QUEUE_THRESHOLD.toLocaleString()} is the most a queue watch takes.`;
    }
  }

  return watchSpecSchema.safeParse(draft.spec).success
    ? null
    : "Something in this watch isn't valid. Check the duration and the condition.";
}
