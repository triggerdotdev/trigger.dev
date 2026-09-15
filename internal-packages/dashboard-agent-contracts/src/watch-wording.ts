/**
 * The words a watch is said in — every surface's single source.
 *
 * `watch.ts` owns the meaning (which resolution and observation mean which
 * category, tone, icon and headline key); this module owns the final English and
 * the value formatting. Pure functions of the contract types, no React and no
 * request context, so the card, the banner, the toast, the email, the Slack
 * message, the webhook and the agent's own deterministic narration all read the
 * same sentence.
 *
 * It lives here rather than in the webapp's presenter because the agent package
 * cannot import the webapp, and a second vocabulary would drift within a release.
 *
 * Nothing outside this module may write a kind-specific watch sentence.
 *
 * Headlines state the fact first. The micro-label carries the "this is a wake"
 * signal.
 */
import {
  isWatchKind,
  resolveWatchResult,
  type WatchExternalNotification,
  type WatchHeadlineKey,
  type WatchKind,
  type WatchObservedOutcome,
  type WatchResolution,
  type WatchResolvedPresentation,
  type WatchSemanticIcon,
  type WatchSpec,
} from "./watch.js";

/** The micro-label above a wake headline. Not part of the fact. */
export const WATCH_UPDATE_LABEL = "Watch update";

/**
 * A fingerprint carries its own `error_` prefix, and every surface names the kind
 * itself — so the prefix is dropped, or the line reads "error error_c4b4a797397a9c43".
 * The rest is shown whole: a truncated hash is not something anyone can look up.
 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.replace(/^error_/, "");
}

/* ------------------------------------------------------------------ *
 * Identity formatting
 * ------------------------------------------------------------------ */

/**
 * The value half of a watch `identity` (`{kind}:{value}`). Read from the identity
 * rather than the spec because the identity is the store's dedup key, so a surface
 * can never disagree with the store about what is being watched. The threshold
 * kinds append their threshold, so only the first segment is the queue name.
 */
const IDENTITY_KINDS_WITH_TRAILING_VALUE = new Set([
  "queue_depth_above",
  "queue_depth_below",
  "queue_oldest_age",
]);

export function watchIdentityValue(kind: string, identity: string): string {
  const value = identity.startsWith(`${kind}:`) ? identity.slice(kind.length + 1) : "";
  if (IDENTITY_KINDS_WITH_TRAILING_VALUE.has(kind)) {
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

/** The bare queue name, for sentences that read better without the word "queue". */
function bareQueueName(identity: string, kind: string): string {
  return watchIdentityValue(kind, identity) || "this queue";
}

/** How an error group is named in a sentence. */
function errorName(identity: string, kind: string): string {
  const value = watchIdentityValue(kind, identity);
  return value ? `Error ${shortFingerprint(value)}` : "The error";
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

/**
 * A wait, in whole minutes once it is minutes. An SLA is stated in minutes, so the
 * wait it is compared against must not carry false seconds-precision.
 */
export function formatWatchWait(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** An SLA, as the card and the headline state it. */
export function formatWatchSla(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
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
 * product is in this switch and nowhere else. Numbers come from the frozen
 * observation, never a fresh read, so a retry produces the same sentence.
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
      // Without an observed depth, stay vague rather than invent a number.
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

    case "queue_back_below": {
      const threshold = observed?.kind === "queue_depth_below" ? observed.threshold : null;
      return threshold === null
        ? `${queueName(identity, kind)} is back below the threshold`
        : `${queueName(identity, kind)} is back below ${threshold}`;
    }
    case "queue_still_above": {
      const threshold = observed?.kind === "queue_depth_below" ? observed.threshold : null;
      return threshold === null
        ? `${queueName(identity, kind)} is still above the threshold`
        : `${queueName(identity, kind)} is still above ${threshold}`;
    }

    case "queue_stalled": {
      // Without an observed depth, say only the fact we do have.
      const depth = observed?.kind === "queue_stalled" ? observed.depth : null;
      return depth === null
        ? `${queueName(identity, kind)} isn't moving`
        : `${queueName(identity, kind)} is stuck at ${depth}`;
    }
    case "queue_kept_moving":
      return `${queueName(identity, kind)} kept moving`;

    case "queue_wait_over_sla": {
      const sla =
        observed?.kind === "queue_oldest_age" ? formatWatchSla(observed.thresholdMinutes) : null;
      const wait = observed?.kind === "queue_oldest_age" ? formatWatchWait(observed.ageMs) : null;
      const queue = bareQueueName(identity, kind);
      if (wait === null) return `runs in ${queue} are waiting too long`;
      return sla === null
        ? `runs in ${queue} are waiting ${wait}`
        : `runs in ${queue} are waiting ${wait} (over your ${sla} limit)`;
    }
    case "queue_wait_under_sla": {
      const sla =
        observed?.kind === "queue_oldest_age" ? formatWatchSla(observed.thresholdMinutes) : null;
      return sla === null
        ? `${queueName(identity, kind)} stayed within its wait limit`
        : `${queueName(identity, kind)} stayed under ${sla}`;
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

    // The window ran out while the source was unreadable, so this deliberately
    // says nothing about the condition itself.
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
 * Present one resolved watch. The single entry point for the banner, the toast and
 * the email; they render this and add nothing of their own.
 */
export function presentResolvedWatch(input: WatchResolvedInput): WatchPresentation {
  // A kind the store knows and this build doesn't must not crash a banner or
  // silence an email, so it degrades to the fallback, which claims no outcome.
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
 * The presentation for a watch whose row this surface couldn't load. It never
 * guesses an outcome.
 */
export const WATCH_PRESENTATION_FALLBACK: WatchPresentation = {
  category: "neutral",
  tone: "neutral",
  semanticIcon: "info",
  headlineKey: "unverified_at_window_end",
  headline: "The watch woke this chat up on its own.",
  label: WATCH_UPDATE_LABEL,
};

/**
 * What the watch was for, under a headline: the user's own words, else whatever
 * names it. The chat banner and the toast both show this line.
 */
export function watchSubline(
  watch: { note?: string | null; identity?: string | null; kind?: string | null } | undefined
): string | null {
  const note = watch?.note?.trim();
  if (note) return note;
  return watch?.identity || watch?.kind || null;
}

/**
 * The note, as a surface with room for a label states it. The email and the Slack
 * message both quote the note, so they quote it the same way.
 */
export function watchNoteLine(note: string): string | null {
  const trimmed = note.trim();
  return trimmed ? `You asked to be told when: ${trimmed}` : null;
}

/* ------------------------------------------------------------------ *
 * The one-shot result block
 * ------------------------------------------------------------------ */

/**
 * What the immediate check answered with, when it answered outright. No watch
 * exists in either case: the check is the delivery, so there is no chip and no wake.
 */
export function immediateWatchMessage(result: string): string {
  switch (result) {
    case "satisfied":
      return "That already happened, so there's nothing left to watch.";
    case "terminal_unsatisfied":
      return "That can't happen any more, so there's nothing to watch.";
    // Not one-shot outcomes: the watch is created and running. Worded here so a
    // confirmation can never fall through to nothing.
    case "unavailable":
      return "We couldn't check that just now. Watching anyway.";
    default:
      return "Watching.";
  }
}

/**
 * The lifetime facts a confirmation always states: how often it checks, that it
 * reports once, and when it gives up.
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
 * The icon a surface should draw, keyed by meaning. Re-exported so the mapping to
 * a concrete glyph lives in the component that owns the icon set.
 */
export type { WatchSemanticIcon };

/* ------------------------------------------------------------------ *
 * The condition, in the four registers the product says it in
 * ------------------------------------------------------------------ */

/** Fixed and always on: the card states it as a fact, not as a choice. */
export const WATCH_IN_CHAT_DELIVERY_LINE = "When there's an answer: tell me in chat";

/**
 * One condition, said four ways. They live in one record per kind rather than in
 * four switches so a reviewer sees them together and they cannot drift apart:
 *
 * - `label` — the card's condition line, read under the subject.
 * - `clause` — follows "Watching {subject} …" in the confirmation.
 * - `tooltip` — the Watch button's tooltip.
 * - `note` — why the watch exists, in the user's voice. The wake quotes it.
 */
export type WatchConditionWording = {
  label: string;
  clause: string;
  tooltip: string;
  note: string;
};

export function watchConditionWording(spec: WatchSpec): WatchConditionWording {
  switch (spec.kind) {
    case "run_start":
      return {
        label: "Until it starts",
        clause: "until it starts",
        tooltip: "Get notified when this run starts",
        note: `tell me when run ${spec.runId} starts`,
      };
    case "run_finished":
      return {
        label: "Until it finishes",
        clause: "until it finishes",
        tooltip: "Get notified when this run finishes",
        note: `tell me when run ${spec.runId} finishes`,
      };
    case "run_failed":
      return {
        label: "If it fails",
        clause: "in case it fails",
        tooltip: "Get notified if this run fails",
        note: `tell me if run ${spec.runId} fails`,
      };
    case "backlog_drain":
      return {
        label: "Until the queue drains",
        clause: "until the queue drains",
        tooltip: "Get notified when this queue drains",
        note: `tell me when the ${spec.queue} queue drains`,
      };
    case "queue_depth_above":
      return {
        label: `If the queue goes above ${spec.threshold}`,
        clause: `in case the queue goes above ${spec.threshold}`,
        tooltip: `Get notified if this queue goes above ${spec.threshold}`,
        note: `tell me if the ${spec.queue} queue goes above ${spec.threshold}`,
      };
    case "queue_depth_below":
      return {
        label: `Until the queue is back below ${spec.threshold}`,
        clause: `until it is back below ${spec.threshold}`,
        tooltip: `Get notified when this queue is back below ${spec.threshold}`,
        note: `tell me when the ${spec.queue} queue is back below ${spec.threshold}`,
      };
    case "queue_stalled":
      return {
        label: "If the queue stops moving",
        clause: "in case it stops moving",
        tooltip: "Get notified if this queue stops moving",
        note: `tell me if the ${spec.queue} queue stops moving`,
      };
    case "queue_oldest_age":
      return {
        label: `If runs wait longer than ${formatWatchSla(spec.thresholdMinutes)}`,
        clause: `in case runs wait longer than ${formatWatchSla(spec.thresholdMinutes)}`,
        tooltip: `Get notified if runs wait longer than ${formatWatchSla(spec.thresholdMinutes)}`,
        note: `tell me if runs in ${spec.queue} wait longer than ${formatWatchSla(
          spec.thresholdMinutes
        )}`,
      };
    case "error_recurrence":
      return {
        label: "If it happens again",
        clause: "in case it happens again",
        tooltip: "Get notified if this error happens again",
        note: `ping me if error ${shortFingerprint(spec.fingerprint)} happens again`,
      };
    case "health_recovery":
      return {
        label: "Until it recovers",
        clause: "until it recovers",
        tooltip: "Get notified when health recovers",
        note: "tell me when health is back to normal",
      };
  }
}

/**
 * What is being watched, as the card's title names it. Read from the spec rather
 * than the identity because the card exists before any watch row does.
 */
export function watchSubjectLabel(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
    case "run_finished":
    case "run_failed":
      return `run ${spec.runId}`;
    case "backlog_drain":
    case "queue_depth_above":
    case "queue_depth_below":
    case "queue_stalled":
    case "queue_oldest_age":
      return spec.queue;
    case "error_recurrence":
      return `error ${shortFingerprint(spec.fingerprint)}`;
    case "health_recovery":
      return "health";
  }
}

/**
 * The condition line. Written to read under the subject, so the two lines together
 * are one sentence without repeating the subject.
 */
export function watchConditionLabel(spec: WatchSpec): string {
  return watchConditionWording(spec).label;
}

/**
 * The line a user's own cancel leaves in the transcript. States that the watch
 * stopped and nothing about what it saw — it is not a wake.
 */
export function watchCancelledSentence(spec: WatchSpec): string {
  return `Stopped watching ${watchSubjectLabel(spec)}.`;
}

/** The Watch button's tooltip. */
export function watchTooltipLabel(spec: WatchSpec): string {
  return watchConditionWording(spec).tooltip;
}

/**
 * The note, restated from the spec. The wake narration quotes the note, so
 * changing the condition or its number must rewrite it. Edits that keep the
 * condition (window, cadence) keep the user's own words.
 */
export function noteFor(spec: WatchSpec): string {
  return watchConditionWording(spec).note;
}

/** The duration line of the card. */
export function watchDurationLabel(spec: WatchSpec): string {
  return `For ${formatWatchWindow(spec.maxHours)} · checking ${formatWatchCadence(
    spec.checkEveryMinutes
  )}`;
}

/* ------------------------------------------------------------------ *
 * The persisted blocks
 * ------------------------------------------------------------------ */

export function watchExternalNotificationLine(external: WatchExternalNotification): string | null {
  switch (external.status) {
    case "enabled":
      return "You'll get an email as well as the chat.";
    case "not_requested":
      return null;
    case "unavailable":
      return "I couldn't add email notifications, so updates will appear in the dashboard only.";
  }
}

/** The follow-up lines a confirmation states, for the opt-ins that took effect. */
export function watchFollowUpLines(followUp: {
  investigateOnAttention?: boolean;
  external?: WatchExternalNotification;
}): string[] {
  const lines: string[] = [];
  if (followUp.investigateOnAttention) {
    lines.push("If it turns out badly, I'll investigate straight away.");
  }
  const external = followUp.external ? watchExternalNotificationLine(followUp.external) : null;
  if (external) lines.push(external);
  return lines;
}

/**
 * What the user confirmed on the card, in their own voice. Written into the
 * transcript before the watch is created, so a running watch can never be
 * missing from the chat that owns it. Deterministic: no model writes this.
 */
export function watchRequestSentence(args: {
  spec: WatchSpec;
  followUp?: { investigateOnAttention?: boolean; notifyExternally?: boolean };
}): string {
  const parts = [
    `Watch ${watchSubjectLabel(args.spec)} ${watchConditionWording(args.spec).clause}.`,
    watchLifetimeSentence({
      checkEveryMinutes: args.spec.checkEveryMinutes,
      maxHours: args.spec.maxHours,
    }),
  ];
  if (args.followUp?.investigateOnAttention) {
    parts.push("Investigate straight away if it turns out badly.");
  }
  if (args.followUp?.notifyExternally) parts.push("Email me as well as the chat.");
  return parts.join(" ");
}

/**
 * The confirmation block: a watch is running. It states the lifetime facts and
 * nothing else, because this block is the transcript record of the request.
 */
export function watchConfirmationBlockBody(args: {
  spec: WatchSpec;
  watchId: string;
  /** The creation-time check couldn't run. Stated plainly rather than hidden. */
  unavailable?: boolean;
  followUp?: { investigateOnAttention?: boolean; external?: WatchExternalNotification };
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
    headline: `Watching ${watchSubjectLabel(args.spec)} ${
      watchConditionWording(args.spec).clause
    }.`,
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
 * The confirmation for a watch that had already resolved before this submission settled
 * (a retry adopting a fired or expired row). It states the outcome the watch reached
 * rather than claiming something is still being watched.
 */
export function watchResolvedBlockBody(args: { watchId: string; resolved: WatchResolvedInput }): {
  type: "watch_result";
  outcome: "already_true" | "impossible";
  headline: string;
  lifetime: null;
  detail: null;
  followUp: never[];
  watchId: string;
} {
  const presented = presentResolvedWatch(args.resolved);
  return {
    type: "watch_result",
    outcome: presented.category === "positive" ? "already_true" : "impossible",
    headline: presented.headline,
    lifetime: null,
    detail: null,
    followUp: [],
    watchId: args.watchId,
  };
}

/**
 * The one-shot result block: the immediate check answered outright, so no watch was
 * created. Nothing is running, so there is no lifetime and no follow-ups.
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
