/**
 * The words a resolved watch is said in. One module, all of them.
 *
 * Two layers, one meaning (§5.2). Contracts owns the **exhaustive resolved-result
 * mapping** — resolution + observed outcome → presentation category, tone,
 * semantic icon and headline *key*. This module owns the **final English**: the
 * headline sentences, the immediate-check outcomes, and the identity / duration /
 * value formatting that goes into them.
 *
 * It is pure and has no React in it, so the banner, the toast and the email
 * template can all render its output. **Components contain no kind-specific
 * wording of their own** — if a component is writing a sentence about a queue or
 * a run, the sentence belongs here.
 *
 * Headlines are FACT FIRST (§5.3): "email-sends queue drained", not "Watch update
 * — all clear". The `WATCH UPDATE` micro-label carries the "this is a wake"
 * signal, so the headline itself is free to just say what happened.
 */
import {
  isWatchKind,
  resolveWatchResult,
  type WatchHeadlineKey,
  type WatchKind,
  type WatchObservedOutcome,
  type WatchResolution,
  type WatchResolvedPresentation,
  type WatchSemanticIcon,
  type WatchSpec,
} from "@internal/dashboard-agent-contracts";

/** The micro-label above a wake headline. Not part of the fact. */
export const WATCH_UPDATE_LABEL = "Watch update";

/** Fingerprints are hashes — show just enough of one to tell them apart. */
const FINGERPRINT_CHARS = 8;

/* ------------------------------------------------------------------ *
 * Identity formatting
 * ------------------------------------------------------------------ */

/**
 * The value half of a watch `identity` (`{kind}:{value}`) — the run id, the queue
 * name, the fingerprint. Taken from the identity rather than the spec because the
 * identity is the store's own dedup key: a surface reading it can never disagree
 * with the store about what is being watched.
 *
 * `queue_depth_above` appends its threshold to the identity, so only the first
 * segment is the queue name.
 */
export function watchIdentityValue(kind: string, identity: string): string {
  const value = identity.startsWith(`${kind}:`) ? identity.slice(kind.length + 1) : "";
  if (kind === "queue_depth_above") {
    const lastColon = value.lastIndexOf(":");
    return lastColon > 0 ? value.slice(0, lastColon) : value;
  }
  return value;
}

/** How a run is named in a sentence. */
function runName(identity: string, kind: string): string {
  const value = watchIdentityValue(kind, identity);
  return value ? `Run ${value}` : "The run";
}

/** How a queue is named in a sentence: the name, then the word "queue". */
function queueName(identity: string, kind: string): string {
  const value = watchIdentityValue(kind, identity);
  return value ? `${value} queue` : "The queue";
}

/** How an error group is named in a sentence. */
function errorName(identity: string, kind: string): string {
  const value = watchIdentityValue(kind, identity);
  return value ? `Error ${value.slice(0, FINGERPRINT_CHARS)}` : "The error";
}

/* ------------------------------------------------------------------ *
 * Value formatting
 * ------------------------------------------------------------------ */

/** A duration in the shortest honest form. Never invents precision. */
export function formatWatchDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${Math.round(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/** A window length, as the confirmation and the tooltip state it. */
export function formatWatchWindow(maxHours: number): string {
  if (maxHours < 1) return `${Math.round(maxHours * 60)} min`;
  return maxHours === 1 ? "1 hour" : `${maxHours} hours`;
}

/** A cadence, as the confirmation and the tooltip state it. */
export function formatWatchCadence(checkEveryMinutes: number): string {
  return checkEveryMinutes === 60 ? "every hour" : `every ${checkEveryMinutes} min`;
}

/* ------------------------------------------------------------------ *
 * Headlines
 * ------------------------------------------------------------------ */

export type WatchResolvedInput = {
  kind: WatchKind | string;
  /** The store's dedup key for the watched thing. */
  identity: string;
  resolution: WatchResolution;
  observed?: WatchObservedOutcome | null;
};

/**
 * The final English for one headline key. Every kind-specific sentence in the
 * product is in this switch and nowhere else.
 *
 * The strings state the FACT, and the depth/threshold numbers come from the
 * frozen observation — never from a fresh read, so the sentence a retry produces
 * is the sentence the first attempt produced (§7.5).
 */
function headlineFor(key: WatchHeadlineKey, input: WatchResolvedInput): string {
  const { kind, identity, observed } = input;

  switch (key) {
    case "run_started":
      return `${runName(identity, kind)} started`;
    case "run_not_started":
      return `${runName(identity, kind)} hasn't started yet`;
    case "run_never_starts":
      return `${runName(identity, kind)} will never start`;

    case "run_finished":
      return `${runName(identity, kind)} finished`;
    case "run_failed":
      return `${runName(identity, kind)} failed`;
    case "run_cancelled":
      return `${runName(identity, kind)} was cancelled`;
    case "run_still_running":
      return `${runName(identity, kind)} is still running`;
    case "run_gone":
      return `${runName(identity, kind)} is no longer there`;

    case "run_no_failure":
      return `${runName(identity, kind)} hasn't failed`;
    case "run_succeeded":
      return `${runName(identity, kind)} succeeded`;

    case "queue_drained":
      return `${queueName(identity, kind)} drained`;
    case "queue_not_drained": {
      // The observed depth makes the fact concrete. Without it, stay vague
      // rather than invent a number.
      const depth = observed?.kind === "backlog_drain" ? observed.depth : null;
      return depth === null
        ? `${queueName(identity, kind)} still hasn't drained`
        : `${queueName(identity, kind)} is still at ${depth}`;
    }
    case "queue_gone":
      return `${queueName(identity, kind)} no longer exists`;

    case "queue_above_threshold": {
      const threshold = observed?.kind === "queue_depth_above" ? observed.threshold : null;
      return threshold === null
        ? `${queueName(identity, kind)} is above the threshold`
        : `${queueName(identity, kind)} is still above ${threshold}`;
    }
    case "queue_stayed_below": {
      const threshold = observed?.kind === "queue_depth_above" ? observed.threshold : null;
      return threshold === null
        ? `${queueName(identity, kind)} stayed below the threshold`
        : `${queueName(identity, kind)} stayed below ${threshold}`;
    }

    case "error_recurred":
      return `${errorName(identity, kind)} happened again`;
    case "error_quiet":
      return `${errorName(identity, kind)} stayed quiet`;

    case "health_recovered":
      return "Health recovered";
    case "health_not_recovered":
      return "Health hasn't recovered";
    case "health_unavailable":
      return "Health couldn't be read";

    // Honest by design: the window ran out while the source was unreadable, so
    // this says nothing about the condition itself.
    case "unverified_at_window_end":
      return "The watch ended without a confirmed answer";

    default: {
      const unreachable: never = key;
      throw new Error(`Unhandled watch headline key: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Everything a surface needs to render one resolved watch. */
export type WatchPresentation = WatchResolvedPresentation & {
  /** The fact, in final English. Complete without any narration under it. */
  headline: string;
  /** The micro-label that marks this as an unprompted wake. */
  label: string;
};

/**
 * Present one resolved watch. The single entry point for the banner, the toast
 * and the email — they render this and add nothing of their own.
 */
export function presentResolvedWatch(input: WatchResolvedInput): WatchPresentation {
  // A kind the store knows and this build doesn't must not crash a banner or
  // silence an email — it degrades to the neutral fallback, which claims
  // nothing about the outcome.
  if (!isWatchKind(input.kind)) return WATCH_PRESENTATION_FALLBACK;

  const resolved = resolveWatchResult({
    kind: input.kind,
    resolution: input.resolution,
    outcome: input.observed ?? null,
  });
  return {
    ...resolved,
    headline: headlineFor(resolved.headlineKey, { ...input, kind: input.kind }),
    label: WATCH_UPDATE_LABEL,
  };
}

/**
 * The same presentation for a watch whose row this surface couldn't load — the
 * banner's fallback (§5.2). It never guesses an outcome.
 */
export const WATCH_PRESENTATION_FALLBACK: WatchPresentation = {
  category: "neutral",
  tone: "neutral",
  semanticIcon: "info",
  headlineKey: "unverified_at_window_end",
  headline: "The watch woke this chat up on its own.",
  label: WATCH_UPDATE_LABEL,
};

/* ------------------------------------------------------------------ *
 * The one-shot result block (§2.2 / §4.1)
 * ------------------------------------------------------------------ */

/**
 * What the immediate check answered with, when it answered outright. No watch
 * exists in either case: the check IS the delivery, and there will be no chip and
 * no wake.
 */
export function immediateWatchMessage(result: string): string {
  switch (result) {
    case "satisfied":
      return "That already happened, so there's nothing left to watch.";
    case "terminal_unsatisfied":
      return "That can't happen any more, so there's nothing to watch.";
    // Not one-shot outcomes — the watch is created and running — but worded here
    // so a confirmation can never fall through to nothing.
    case "unavailable":
      return "We couldn't check that just now. Watching anyway.";
    default:
      return "Watching.";
  }
}

/**
 * The four lifetime facts a confirmation always states (§5.1.4): what · how often
 * it checks · that it reports once · when it gives up.
 */
export function watchLifetimeSentence(args: {
  checkEveryMinutes: number;
  maxHours: number;
}): string {
  return `Checking ${formatWatchCadence(args.checkEveryMinutes)} for up to ${formatWatchWindow(
    args.maxHours
  )}. It reports once, then stops.`;
}

/**
 * The icon a surface should draw, keyed by MEANING. Exported so the mapping from
 * semantic icon to a concrete glyph lives in the component that owns the icon
 * set, and the choice itself stays here.
 */
export type { WatchSemanticIcon };

/* ------------------------------------------------------------------ *
 * The configuration card (§2.2)
 * ------------------------------------------------------------------ */

/** Fixed, always on: the card states it as a fact, not as a choice (§2.2). */
export const WATCH_IN_CHAT_DELIVERY_LINE = "When there's an answer: tell me in chat";

/**
 * WHAT is being watched, as the card's title names it — from the SPEC, because
 * the card exists before any watch row does. The `{kind}:{value}` identity
 * formatting above is the same answer read off the store; this is the same answer
 * read off the draft.
 */
export function watchSubjectLabel(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
    case "run_finished":
    case "run_failed":
      return `run ${spec.runId}`;
    case "backlog_drain":
    case "queue_depth_above":
      return spec.queue;
    case "error_recurrence":
      return `error ${spec.fingerprint.slice(0, FINGERPRINT_CHARS)}`;
    case "health_recovery":
      return "health";
  }
}

/**
 * The condition line: "Until the queue drains", "If it fails". Written as the
 * user would read it under the subject, so the two lines together are one
 * sentence without repeating the subject.
 */
export function watchConditionLabel(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
      return "Until it starts";
    case "run_finished":
      return "Until it finishes";
    case "run_failed":
      return "If it fails";
    case "backlog_drain":
      return "Until the queue drains";
    case "queue_depth_above":
      return `If the queue goes above ${spec.threshold}`;
    case "error_recurrence":
      return "If it happens again";
    case "health_recovery":
      return "Until it recovers";
  }
}

/** "For 1 hour · checking every 5 min" — the duration line of the card. */
export function watchDurationLabel(spec: WatchSpec): string {
  return `For ${formatWatchWindow(spec.maxHours)} · checking ${formatWatchCadence(
    spec.checkEveryMinutes
  )}`;
}

/** The condition as a clause that follows "Watching {subject} …". */
function watchConditionClause(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
      return "until it starts";
    case "run_finished":
      return "until it finishes";
    case "run_failed":
      return "in case it fails";
    case "backlog_drain":
      return "until the queue drains";
    case "queue_depth_above":
      return `in case the queue goes above ${spec.threshold}`;
    case "error_recurrence":
      return "in case it happens again";
    case "health_recovery":
      return "until it recovers";
  }
}

/* ------------------------------------------------------------------ *
 * The persisted blocks (§2.2)
 * ------------------------------------------------------------------ */

/** The follow-up lines a confirmation states, for the opt-ins that took effect. */
export function watchFollowUpLines(followUp: {
  investigateOnAttention?: boolean;
  notifyExternally?: boolean;
}): string[] {
  const lines: string[] = [];
  if (followUp.investigateOnAttention) {
    lines.push("If it turns out badly, I'll investigate straight away.");
  }
  if (followUp.notifyExternally) lines.push("You'll get an email as well as the chat.");
  return lines;
}

/**
 * The CONFIRMATION block: a watch is running. It states the four lifetime facts
 * (§5.1.4) and nothing else — no separate request line, because this block is the
 * transcript record of the request.
 */
export function watchConfirmationBlockBody(args: {
  spec: WatchSpec;
  watchId: string;
  /** The creation-time check couldn't run. Said plainly rather than hidden. */
  unavailable?: boolean;
  followUp?: { investigateOnAttention?: boolean; notifyExternally?: boolean };
}): {
  type: "watch_result";
  outcome: "watching";
  headline: string;
  lifetime: string;
  detail: string | null;
  followUp: string[];
  watchId: string;
} {
  return {
    type: "watch_result",
    outcome: "watching",
    headline: `Watching ${watchSubjectLabel(args.spec)} ${watchConditionClause(args.spec)}.`,
    lifetime: watchLifetimeSentence({
      checkEveryMinutes: args.spec.checkEveryMinutes,
      maxHours: args.spec.maxHours,
    }),
    detail: args.unavailable ? immediateWatchMessage("unavailable") : null,
    followUp: watchFollowUpLines(args.followUp ?? {}),
    watchId: args.watchId,
  };
}

/**
 * The ONE-SHOT RESULT block: the immediate check answered outright, so no watch
 * was created. No lifetime — there is nothing running to have one — and no
 * follow-ups, because there is no later outcome to follow up on.
 */
export function watchOneShotBlockBody(args: {
  spec: WatchSpec;
  result: "satisfied" | "terminal_unsatisfied";
}): {
  type: "watch_result";
  outcome: "already_true" | "impossible";
  headline: string;
  lifetime: null;
  detail: null;
  followUp: never[];
  watchId: null;
} {
  const satisfied = args.result === "satisfied";
  return {
    type: "watch_result",
    outcome: satisfied ? "already_true" : "impossible",
    headline: immediateWatchMessage(args.result),
    lifetime: null,
    detail: null,
    followUp: [],
    watchId: null,
  };
}
